import { createHash } from 'node:crypto'

const OPERATION = 'admin.cash_receipt'

const IDEMPOTENCY_SQL = `
  SELECT
    id,
    btrim(request_hash) AS request_hash,
    response_status,
    response_body,
    expires_at <= clock_timestamp() AS expired
  FROM public.idempotency_keys
  WHERE operation = $1
    AND idempotency_key = $2
    AND user_id = $3::uuid
    AND session_id IS NULL
  FOR UPDATE
`

const DELETE_IDEMPOTENCY_SQL = `
  DELETE FROM public.idempotency_keys
  WHERE id = $1::uuid
`

const LOCK_ORDER_SQL = `
  SELECT
    id,
    order_number,
    payment_method,
    payment_status,
    fulfillment_status
  FROM public.orders
  WHERE id = $1::uuid
  FOR UPDATE
`

const LOCK_PAYMENTS_SQL = `
  SELECT id, method, status, refunded_amount
  FROM public.payments
  WHERE order_id = $1::uuid
  ORDER BY id
  FOR UPDATE
`

const LOCK_RESERVATIONS_SQL = `
  SELECT
    r.id,
    r.order_item_id,
    r.product_id,
    r.quantity,
    r.status,
    r.payment_method,
    oi.quantity AS item_quantity,
    oi.product_id AS item_product_id
  FROM public.inventory_reservations AS r
  JOIN public.order_items AS oi
    ON oi.id = r.order_item_id
   AND oi.order_id = r.order_id
  WHERE r.order_id = $1::uuid
  ORDER BY r.id
  FOR UPDATE OF r
`

const COUNT_ITEMS_SQL = `
  SELECT count(*)::integer AS items
  FROM public.order_items
  WHERE order_id = $1::uuid
`

const LOCK_PRODUCTS_SQL = `
  SELECT id, stock_quantity
  FROM public.products
  WHERE id = ANY($1::uuid[])
  ORDER BY id
  FOR UPDATE
`

const DECREMENT_STOCK_SQL = `
  UPDATE public.products
  SET stock_quantity = stock_quantity - $2::integer
  WHERE id = $1::uuid
    AND stock_quantity IS NOT NULL
    AND stock_quantity >= $2::integer
  RETURNING id
`

const CONSUME_SQL = `
  UPDATE public.inventory_reservations
  SET status = 'consumed'
  WHERE order_id = $1::uuid
    AND status = 'active'
    AND id = ANY($2::uuid[])
  RETURNING id
`

const PAY_SQL = `
  UPDATE public.payments
  SET status = 'paid',
      paid_at = clock_timestamp()
  WHERE id = $1::uuid
    AND order_id = $2::uuid
    AND method = 'cash'
    AND provider IS NULL
    AND status = 'pending'
    AND refunded_amount = 0
  RETURNING id, paid_at
`

const MARK_ORDER_SQL = `
  UPDATE public.orders
  SET payment_status = 'paid'
  WHERE id = $1::uuid
    AND payment_method = 'cash'
    AND payment_status = 'pending'
    AND fulfillment_status = 'new'
  RETURNING id, order_number, fulfillment_status
`

const INSERT_HISTORY_SQL = `
  INSERT INTO public.order_status_history (
    order_id, status_type, old_status, new_status, changed_by
  )
  VALUES ($1::uuid, 'payment', 'pending', 'paid', $2::uuid)
`

const INSERT_EVENT_SQL = `
  INSERT INTO public.payment_events (
    payment_id, provider, provider_event_id, event_type, payload, processed_at
  )
  VALUES (
    $1::uuid, 'manual', NULL, 'cash_received', $2::jsonb, clock_timestamp()
  )
`

const INSERT_IDEMPOTENCY_SQL = `
  INSERT INTO public.idempotency_keys (
    idempotency_key,
    operation,
    user_id,
    session_id,
    request_hash,
    response_status,
    response_body,
    order_id,
    expires_at
  )
  VALUES (
    $1, $2, $3::uuid, NULL, $4, $5::integer, $6::jsonb, $7::uuid,
    clock_timestamp() + interval '24 hours'
  )
`

export class CashReceiptRejection extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'CashReceiptRejection'
    this.status = status
    this.code = code
  }
}

export function cashReceiptRequestHash(orderId) {
  return createHash('sha256').update(String(orderId), 'utf8').digest('hex')
}

export async function confirmCashReceipt(
  tx,
  { adminUserId, orderId, idempotencyKey },
) {
  const requestHash = cashReceiptRequestHash(orderId)
  const early = await replayOrClear(
    tx,
    adminUserId,
    idempotencyKey,
    requestHash,
  )

  if (early) {
    return early
  }

  const order = await lockOrder(tx, orderId)
  const replay = await replayOrClear(
    tx,
    adminUserId,
    idempotencyKey,
    requestHash,
  )

  if (replay) {
    return replay
  }

  assertConfirmable(order)
  const payment = await lockPendingCashPayment(tx, order.id)
  const reservations = await lockActiveReservations(tx, order.id)
  const quantities = quantitiesByProduct(reservations)
  await lockProducts(tx, [...quantities.keys()])
  await decrementStock(tx, quantities)
  await consumeReservations(tx, order.id, reservations)
  const paid = await markPaid(tx, payment.id, order.id)
  await tx.query(INSERT_HISTORY_SQL, [order.id, adminUserId])
  await tx.query(INSERT_EVENT_SQL, [
    payment.id,
    JSON.stringify({ orderId: order.id, paymentId: payment.id }),
  ])
  const response = receiptResponse(order, paid.paid_at)
  await tx.query(INSERT_IDEMPOTENCY_SQL, [
    idempotencyKey,
    OPERATION,
    adminUserId,
    requestHash,
    response.status,
    JSON.stringify(response.body),
    order.id,
  ])

  return response
}

async function replayOrClear(tx, adminUserId, idempotencyKey, requestHash) {
  const result = await tx.query(IDEMPOTENCY_SQL, [
    OPERATION,
    idempotencyKey,
    adminUserId,
  ])
  const row = result.rows[0]

  if (!row) {
    return null
  }

  if (row.expired) {
    await tx.query(DELETE_IDEMPOTENCY_SQL, [row.id])
    return null
  }

  if (row.request_hash !== requestHash) {
    reject(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused')
  }

  if (
    row.response_status === null ||
    row.response_body === null ||
    typeof row.response_body !== 'object'
  ) {
    reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
  }

  return { status: row.response_status, body: row.response_body }
}

async function lockOrder(tx, orderId) {
  const result = await tx.query(LOCK_ORDER_SQL, [orderId])
  const order = result.rows[0]

  if (!order) {
    reject(404, 'NOT_FOUND', 'Resource not found')
  }

  return order
}

function assertConfirmable(order) {
  if (order.payment_method !== 'cash') {
    reject(409, 'NOT_CASH_PAYMENT', 'Cash confirmation does not apply')
  }

  if (order.payment_status !== 'pending') {
    reject(409, 'PAYMENT_NOT_PENDING', 'Payment cannot be confirmed')
  }

  if (order.fulfillment_status !== 'new') {
    reject(409, 'FULFILLMENT_NOT_NEW', 'Order cannot be confirmed')
  }
}

async function lockPendingCashPayment(tx, orderId) {
  const result = await tx.query(LOCK_PAYMENTS_SQL, [orderId])
  const payment = result.rows.length === 1 ? result.rows[0] : null

  if (
    !payment ||
    payment.method !== 'cash' ||
    payment.status !== 'pending' ||
    String(payment.refunded_amount) !== '0'
  ) {
    reject(409, 'PAYMENT_NOT_PENDING', 'Payment cannot be confirmed')
  }

  return payment
}

async function lockActiveReservations(tx, orderId) {
  const reservations = await tx.query(LOCK_RESERVATIONS_SQL, [orderId])
  const items = await tx.query(COUNT_ITEMS_SQL, [orderId])
  const rows = reservations.rows

  if (rows.length === 0 || rows.length !== items.rows[0].items) {
    reject(409, 'RESERVATION_NOT_ACTIVE', 'Reservation cannot be consumed')
  }

  for (const row of rows) {
    if (
      row.status !== 'active' ||
      row.payment_method !== 'cash' ||
      row.product_id === null ||
      row.product_id !== row.item_product_id ||
      !Number.isSafeInteger(row.quantity) ||
      row.quantity < 1 ||
      row.quantity !== row.item_quantity
    ) {
      reject(409, 'RESERVATION_NOT_ACTIVE', 'Reservation cannot be consumed')
    }
  }

  return rows
}

function quantitiesByProduct(reservations) {
  const quantities = new Map()

  for (const row of reservations) {
    quantities.set(
      row.product_id,
      (quantities.get(row.product_id) ?? 0) + row.quantity,
    )
  }

  for (const quantity of quantities.values()) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      reject(409, 'RESERVATION_NOT_ACTIVE', 'Reservation cannot be consumed')
    }
  }

  return quantities
}

async function lockProducts(tx, productIds) {
  const result = await tx.query(LOCK_PRODUCTS_SQL, [productIds])

  if (result.rows.length !== productIds.length) {
    reject(409, 'RESERVATION_NOT_ACTIVE', 'Reservation cannot be consumed')
  }
}

async function decrementStock(tx, quantities) {
  const ids = [...quantities.keys()].sort()

  for (const productId of ids) {
    const updated = await tx.query(DECREMENT_STOCK_SQL, [
      productId,
      quantities.get(productId),
    ])

    if (updated.rows.length !== 1) {
      reject(409, 'INSUFFICIENT_STOCK', 'Insufficient stock')
    }
  }
}

async function consumeReservations(tx, orderId, reservations) {
  const updated = await tx.query(CONSUME_SQL, [
    orderId,
    reservations.map((row) => row.id),
  ])

  if (updated.rows.length !== reservations.length) {
    reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
  }
}

async function markPaid(tx, paymentId, orderId) {
  const paid = await tx.query(PAY_SQL, [paymentId, orderId])

  if (paid.rows.length !== 1) {
    reject(409, 'PAYMENT_NOT_PENDING', 'Payment cannot be confirmed')
  }

  const order = await tx.query(MARK_ORDER_SQL, [orderId])

  if (order.rows.length !== 1) {
    reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
  }

  return paid.rows[0]
}

function receiptResponse(order, paidAt) {
  return {
    status: 200,
    body: {
      data: {
        id: order.id,
        orderNumber: order.order_number,
        paymentMethod: 'cash',
        paymentStatus: 'paid',
        fulfillmentStatus: 'new',
        paidAt: new Date(paidAt).toISOString(),
      },
      meta: {},
    },
  }
}

function reject(status, code, message) {
  throw new CashReceiptRejection(status, code, message)
}
