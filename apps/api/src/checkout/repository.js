import { randomBytes } from 'node:crypto'
import {
  ACCOUNT_CART_LOCK_NAMESPACE,
  GUEST_CART_LOCK_NAMESPACE,
  accountCartLockKey,
  guestCartLockKey,
} from '../cart/repository.js'
import {
  OrderAmountError,
  calculateOrderAmounts,
} from '../order-amounts/calculate.js'
import { checkoutRequestHash } from './validation.js'

const CHECKOUT_OPERATION = 'checkout'
const ZERO_TAX_STRATEGY = 'per_line'

const LOCK_SQL = `
  SELECT pg_advisory_xact_lock($1::integer, $2::integer)
`

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
    AND (
      ($3::uuid IS NOT NULL AND user_id = $3::uuid)
      OR ($4::char(64) IS NOT NULL AND session_id = $4::char(64))
    )
  FOR UPDATE
`

const DELETE_IDEMPOTENCY_SQL = `
  DELETE FROM public.idempotency_keys
  WHERE id = $1::uuid
`

const GUEST_CART_SQL = `
  SELECT id, status, btrim(currency) AS currency
  FROM public.carts
  WHERE session_id = $1
    AND user_id IS NULL
    AND status IN ('active', 'converted')
  ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END
  FOR UPDATE
`

const ACCOUNT_CART_SQL = `
  SELECT id, status, btrim(currency) AS currency
  FROM public.carts
  WHERE user_id = $1::uuid
    AND session_id IS NULL
    AND status IN ('active', 'converted')
  ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END
  FOR UPDATE
`

const ITEMS_SQL = `
  SELECT product_id, quantity
  FROM public.cart_items
  WHERE cart_id = $1::uuid
  ORDER BY product_id
`

const SELLER_SQL = `
  SELECT
    seller_tax_status,
    business_name,
    nip,
    street,
    building_number,
    unit_number,
    postal_code,
    city,
    country_code
  FROM public.shop_profile
  WHERE id = true
  FOR SHARE
`

const PRODUCTS_SQL = `
  SELECT
    id,
    name,
    product_type,
    sku,
    price_amount::text AS price_amount,
    btrim(currency) AS currency,
    tax_status,
    vat_rate::text AS vat_rate,
    is_active,
    stock_quantity
  FROM public.products
  WHERE id = ANY($1::uuid[])
  ORDER BY id
  FOR UPDATE
`

const RESERVED_SQL = `
  SELECT COALESCE(sum(quantity), 0)::text AS reserved
  FROM public.inventory_reservations
  WHERE product_id = $1::uuid
    AND status = 'active'
`

const ACCOUNT_CUSTOMER_SQL = `
  SELECT id, email
  FROM public.customers
  WHERE user_id = $1::uuid
`

const INSERT_CUSTOMER_SQL = `
  INSERT INTO public.customers (
    user_id, customer_type, email, phone, first_name, last_name, company_name, nip
  )
  VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (user_id) WHERE user_id IS NOT NULL
  DO NOTHING
  RETURNING id
`

const INSERT_ORDER_SQL = `
  INSERT INTO public.orders (
    order_number,
    customer_id,
    user_id,
    customer_email,
    customer_type,
    billing_snapshot,
    seller_tax_status_snapshot,
    seller_business_name_snapshot,
    seller_nip_snapshot,
    seller_street_snapshot,
    seller_building_number_snapshot,
    seller_unit_number_snapshot,
    seller_postal_code_snapshot,
    seller_city_snapshot,
    seller_country_code_snapshot,
    currency,
    net_amount,
    tax_amount,
    gross_amount,
    payment_method,
    payment_status,
    fulfillment_status,
    session_id
  )
  VALUES (
    $1, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13,
    $14, $15, $16, $17::bigint, $18::bigint, $19::bigint, 'cash', 'pending', 'new',
    $20::char(64)
  )
  RETURNING id, order_number, payment_status, fulfillment_status, payment_method,
    btrim(currency) AS currency, net_amount::text AS net_amount,
    tax_amount::text AS tax_amount, gross_amount::text AS gross_amount
`

const INSERT_ITEM_SQL = `
  INSERT INTO public.order_items (
    order_id,
    product_id,
    product_name_snapshot,
    product_type_snapshot,
    sku_snapshot,
    currency,
    catalog_tax_status_snapshot,
    catalog_vat_rate_snapshot,
    tax_status_snapshot,
    vat_rate_snapshot,
    unit_gross_amount,
    quantity,
    line_net_amount,
    line_tax_amount,
    line_gross_amount
  )
  VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9, $10::numeric,
    $11::bigint, $12::integer, $13::bigint, $14::bigint, $15::bigint
  )
  RETURNING id
`

const INSERT_HISTORY_SQL = `
  INSERT INTO public.order_status_history (
    order_id, status_type, old_status, new_status, changed_by
  )
  VALUES ($1::uuid, $2, NULL, $3, $4::uuid)
`

const INSERT_PAYMENT_SQL = `
  INSERT INTO public.payments (
    order_id, method, provider, provider_transaction_id, status, amount, currency
  )
  VALUES ($1::uuid, 'cash', NULL, NULL, 'pending', $2::bigint, $3)
`

const INSERT_RESERVATION_SQL = `
  INSERT INTO public.inventory_reservations (
    order_id, order_item_id, product_id, payment_method, quantity, status, expires_at
  )
  VALUES ($1::uuid, $2::uuid, $3::uuid, 'cash', $4::integer, 'active', NULL)
`

const CONVERT_CART_SQL = `
  UPDATE public.carts
  SET status = 'converted'
  WHERE id = $1::uuid
    AND status = 'active'
  RETURNING id
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
    $1, $2, $3::uuid, $4::char(64), $5, $6::integer, $7::jsonb, $8::uuid,
    clock_timestamp() + interval '24 hours'
  )
`

export class CheckoutRejection extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'CheckoutRejection'
    this.status = status
    this.code = code
  }
}

const INSERT_ONLINE_ORDER_SQL = `
  INSERT INTO public.orders (
    order_number,
    customer_id,
    user_id,
    customer_email,
    customer_type,
    billing_snapshot,
    seller_tax_status_snapshot,
    seller_business_name_snapshot,
    seller_nip_snapshot,
    seller_street_snapshot,
    seller_building_number_snapshot,
    seller_unit_number_snapshot,
    seller_postal_code_snapshot,
    seller_city_snapshot,
    seller_country_code_snapshot,
    currency,
    net_amount,
    tax_amount,
    gross_amount,
    payment_method,
    payment_status,
    fulfillment_status,
    session_id
  )
  VALUES (
    $1, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13,
    $14, $15, $16, $17::bigint, $18::bigint, $19::bigint, 'online', 'pending', 'new',
    $20::char(64)
  )
  RETURNING id, order_number, payment_status, fulfillment_status, payment_method,
    btrim(currency) AS currency, net_amount::text AS net_amount,
    tax_amount::text AS tax_amount, gross_amount::text AS gross_amount
`

const INSERT_ONLINE_PAYMENT_SQL = `
  INSERT INTO public.payments (
    order_id,
    method,
    provider,
    provider_transaction_id,
    status,
    amount,
    currency,
    initialization_status,
    redirect_token
  )
  VALUES (
    $1::uuid, 'online', 'przelewy24', NULL, 'pending', $2::bigint, $3,
    'not_started', NULL
  )
  RETURNING id
`

const INSERT_ONLINE_RESERVATION_SQL = `
  INSERT INTO public.inventory_reservations (
    order_id, order_item_id, product_id, payment_method, quantity, status, expires_at
  )
  VALUES (
    $1::uuid, $2::uuid, $3::uuid, 'online', $4::integer, 'active',
    clock_timestamp() + interval '15 minutes'
  )
`

export async function placeCheckoutOrder(
  tx,
  { owner, idempotencyKey, body, onlineReady = false },
) {
  await lockOwner(tx, owner)
  const requestHash = checkoutRequestHash(body)
  const replay = await readIdempotency(tx, owner, idempotencyKey, requestHash)

  if (replay) {
    if (replay.body?.data?.paymentMethod === 'online') {
      return { online: { orderId: replay.body.data.id } }
    }

    return replay
  }

  if (body.paymentMethod === 'online') {
    if (!onlineReady) {
      reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
    }

    return createOnlineOrder(tx, { owner, idempotencyKey, body, requestHash })
  }

  const cart = await lockCart(tx, owner)

  if (!cart) {
    reject(404, 'NOT_FOUND', 'Resource not found')
  }

  if (cart.status === 'converted') {
    reject(409, 'CART_CONVERTED', 'Cart is already converted')
  }

  if (cart.currency !== 'PLN') {
    reject(400, 'VALIDATION_ERROR', 'Invalid request data')
  }

  const seller = await readSeller(tx)
  const items = await readItems(tx, cart.id)
  const products = await lockProducts(tx, items)
  const prepared = await prepareLines(
    tx,
    items,
    products,
    seller.seller_tax_status,
  )
  let amounts

  try {
    amounts = calculateOrderAmounts({
      sellerTaxStatus: seller.seller_tax_status,
      strategy: ZERO_TAX_STRATEGY,
      lines: prepared.lines,
    })
  } catch (error) {
    if (error instanceof OrderAmountError) {
      reject(
        409,
        'PRODUCT_UNAVAILABLE',
        'Cart has products that cannot be purchased',
      )
    }

    throw error
  }

  if (!amounts.lineAmountsComplete) {
    reject(409, 'VAT_POLICY_NOT_CONFIRMED', 'VAT policy is not confirmed')
  }

  const customerId = await customerForOrder(tx, owner, body)
  const order = await insertOrder(tx, {
    customerId,
    owner,
    body,
    seller,
    amounts,
  })
  const orderItems = await insertItems(tx, order.id, prepared.products, amounts)
  await insertHistory(tx, order.id, owner)
  await insertPayment(tx, order)
  await insertReservations(tx, order.id, orderItems)
  await convertCart(tx, cart.id)
  const response = orderResponse(order)
  await insertIdempotency(tx, {
    owner,
    idempotencyKey,
    requestHash,
    orderId: order.id,
    response,
  })

  return { status: 201, body: response }
}

async function createOnlineOrder(
  tx,
  { owner, idempotencyKey, body, requestHash },
) {
  const cart = await lockCart(tx, owner)

  if (!cart) {
    reject(404, 'NOT_FOUND', 'Resource not found')
  }

  if (cart.status === 'converted') {
    reject(409, 'CART_CONVERTED', 'Cart is already converted')
  }

  if (cart.currency !== 'PLN') {
    reject(400, 'VALIDATION_ERROR', 'Invalid request data')
  }

  const seller = await readSeller(tx)
  const items = await readItems(tx, cart.id)
  const products = await lockProducts(tx, items)
  const prepared = await prepareLines(
    tx,
    items,
    products,
    seller.seller_tax_status,
  )
  let amounts

  try {
    amounts = calculateOrderAmounts({
      sellerTaxStatus: seller.seller_tax_status,
      strategy: ZERO_TAX_STRATEGY,
      lines: prepared.lines,
    })
  } catch (error) {
    if (error instanceof OrderAmountError) {
      reject(
        409,
        'PRODUCT_UNAVAILABLE',
        'Cart has products that cannot be purchased',
      )
    }

    throw error
  }

  if (!amounts.lineAmountsComplete) {
    reject(409, 'VAT_POLICY_NOT_CONFIRMED', 'VAT policy is not confirmed')
  }

  const customerId = await customerForOrder(tx, owner, body)
  const order = await tx.query(INSERT_ONLINE_ORDER_SQL, [
    `C${cryptoRandom()}`,
    customerId,
    owner.kind === 'account' ? owner.key : null,
    body.email,
    body.customerType,
    JSON.stringify(billingSnapshot(body.billing)),
    seller.seller_tax_status,
    seller.business_name,
    seller.nip,
    seller.street,
    seller.building_number,
    seller.unit_number,
    seller.postal_code,
    seller.city,
    seller.country_code,
    'PLN',
    amounts.totals.net,
    amounts.totals.tax,
    amounts.totals.gross,
    orderSessionId(owner),
  ])
  const created = order.rows[0]
  const orderItems = await insertItems(
    tx,
    created.id,
    prepared.products,
    amounts,
  )
  await insertHistory(tx, created.id, owner)
  await tx.query(INSERT_ONLINE_PAYMENT_SQL, [
    created.id,
    created.gross_amount,
    'PLN',
  ])
  for (const item of orderItems) {
    await tx.query(INSERT_ONLINE_RESERVATION_SQL, [
      created.id,
      item.id,
      item.product.id,
      item.quantity,
    ])
  }
  await convertCart(tx, cart.id)
  const response = {
    data: {
      ...orderResponse(created).data,
      payment: { initializationStatus: 'not_started' },
    },
    meta: {},
  }
  await insertIdempotency(tx, {
    owner,
    idempotencyKey,
    requestHash,
    orderId: created.id,
    response,
  })

  return { online: { orderId: created.id } }
}

async function lockOwner(tx, owner) {
  const namespace =
    owner.kind === 'account'
      ? ACCOUNT_CART_LOCK_NAMESPACE
      : GUEST_CART_LOCK_NAMESPACE
  const key =
    owner.kind === 'account'
      ? accountCartLockKey(owner.key)
      : guestCartLockKey(owner.key)

  await tx.query(LOCK_SQL, [namespace, key])
}

async function readIdempotency(tx, owner, idempotencyKey, requestHash) {
  const result = await tx.query(IDEMPOTENCY_SQL, [
    CHECKOUT_OPERATION,
    idempotencyKey,
    owner.kind === 'account' ? owner.key : null,
    owner.kind === 'guest' ? owner.key : null,
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

async function lockCart(tx, owner) {
  const result = await tx.query(
    owner.kind === 'account' ? ACCOUNT_CART_SQL : GUEST_CART_SQL,
    [owner.key],
  )
  const active = result.rows.find((cart) => cart.status === 'active')

  if (active) {
    return active
  }

  return result.rows.find((cart) => cart.status === 'converted') ?? null
}

async function readSeller(tx) {
  const result = await tx.query(SELLER_SQL)
  const seller = result.rows[0]

  if (!seller) {
    reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
  }

  if (seller.seller_tax_status === 'unknown') {
    reject(409, 'SELLER_TAX_STATUS_UNKNOWN', 'Checkout is unavailable')
  }

  if (
    seller.seller_tax_status !== 'registered' &&
    seller.seller_tax_status !== 'exempt'
  ) {
    reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
  }

  return seller
}

async function readItems(tx, cartId) {
  const result = await tx.query(ITEMS_SQL, [cartId])

  if (result.rows.length === 0) {
    reject(409, 'CART_EMPTY', 'Cart is empty')
  }

  return result.rows
}

async function lockProducts(tx, items) {
  const ids = items.map((item) => item.product_id).sort()
  const result = await tx.query(PRODUCTS_SQL, [ids])
  const products = new Map(result.rows.map((product) => [product.id, product]))

  if (products.size !== ids.length) {
    reject(
      409,
      'PRODUCT_UNAVAILABLE',
      'Cart has products that cannot be purchased',
    )
  }

  return products
}

async function prepareLines(tx, items, products, sellerTaxStatus) {
  const ordered = [...items].sort((left, right) =>
    left.product_id < right.product_id ? -1 : 1,
  )
  const lines = []
  const selected = []

  for (const item of ordered) {
    const product = products.get(item.product_id)

    if (!product.is_active || product.currency !== 'PLN') {
      reject(
        product.currency === 'PLN' ? 409 : 400,
        product.currency === 'PLN' ? 'PRODUCT_UNAVAILABLE' : 'VALIDATION_ERROR',
        product.currency === 'PLN'
          ? 'Cart has products that cannot be purchased'
          : 'Invalid request data',
      )
    }

    if (sellerTaxStatus === 'registered' && product.tax_status === 'standard') {
      reject(409, 'VAT_POLICY_NOT_CONFIRMED', 'VAT policy is not confirmed')
    }

    await assertStock(tx, product, item.quantity)
    lines.push({
      unitGross: product.price_amount,
      quantity: item.quantity,
      taxStatus: product.tax_status,
      vatRate: product.vat_rate,
    })
    selected.push(product)
  }

  return { lines, products: selected }
}

async function assertStock(tx, product, quantity) {
  if (product.stock_quantity === null) {
    reject(409, 'STOCK_UNKNOWN', 'Stock is unknown')
  }

  const reserved = await tx.query(RESERVED_SQL, [product.id])
  const available =
    BigInt(product.stock_quantity) - BigInt(reserved.rows[0].reserved)

  if (available < BigInt(quantity)) {
    reject(409, 'INSUFFICIENT_STOCK', 'Insufficient stock')
  }
}

async function customerForOrder(tx, owner, body) {
  if (owner.kind === 'account') {
    const existing = await tx.query(ACCOUNT_CUSTOMER_SQL, [owner.key])

    if (existing.rows[0]) {
      return existing.rows[0].id
    }
  }

  const inserted = await tx.query(INSERT_CUSTOMER_SQL, [
    owner.kind === 'account' ? owner.key : null,
    body.customerType,
    body.email,
    body.billing.phone ?? null,
    body.billing.firstName ?? null,
    body.billing.lastName ?? null,
    body.billing.companyName ?? null,
    body.billing.nip ?? null,
  ])

  if (inserted.rows[0]) {
    return inserted.rows[0].id
  }

  const reread = await tx.query(ACCOUNT_CUSTOMER_SQL, [owner.key])

  if (!reread.rows[0]) {
    reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
  }

  return reread.rows[0].id
}

async function insertOrder(tx, { customerId, owner, body, seller, amounts }) {
  const orderNumber = `C${cryptoRandom()}`
  const result = await tx.query(INSERT_ORDER_SQL, [
    orderNumber,
    customerId,
    owner.kind === 'account' ? owner.key : null,
    body.email,
    body.customerType,
    JSON.stringify(billingSnapshot(body.billing)),
    seller.seller_tax_status,
    seller.business_name,
    seller.nip,
    seller.street,
    seller.building_number,
    seller.unit_number,
    seller.postal_code,
    seller.city,
    seller.country_code,
    'PLN',
    amounts.totals.net,
    amounts.totals.tax,
    amounts.totals.gross,
    orderSessionId(owner),
  ])

  return result.rows[0]
}

async function insertItems(tx, orderId, products, amounts) {
  const rows = []

  for (let index = 0; index < products.length; index += 1) {
    const product = products[index]
    const quote = amounts.lines[index]
    const inserted = await tx.query(INSERT_ITEM_SQL, [
      orderId,
      product.id,
      product.name,
      product.product_type,
      product.sku,
      'PLN',
      quote.catalogTaxStatus,
      quote.catalogVatRate,
      quote.appliedTaxStatus,
      quote.appliedVatRate,
      quote.unitGross,
      quote.quantity,
      quote.lineNet,
      quote.lineTax,
      quote.lineGross,
    ])
    rows.push({ id: inserted.rows[0].id, product, quantity: quote.quantity })
  }

  return rows
}

async function insertHistory(tx, orderId, owner) {
  const changedBy = owner.kind === 'account' ? owner.key : null

  await tx.query(INSERT_HISTORY_SQL, [orderId, 'payment', 'pending', changedBy])
  await tx.query(INSERT_HISTORY_SQL, [orderId, 'fulfillment', 'new', changedBy])
}

async function insertPayment(tx, order) {
  await tx.query(INSERT_PAYMENT_SQL, [order.id, order.gross_amount, 'PLN'])
}

async function insertReservations(tx, orderId, items) {
  for (const item of items) {
    await tx.query(INSERT_RESERVATION_SQL, [
      orderId,
      item.id,
      item.product.id,
      item.quantity,
    ])
  }
}

async function convertCart(tx, cartId) {
  const result = await tx.query(CONVERT_CART_SQL, [cartId])

  if (result.rows.length !== 1) {
    reject(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
  }
}

async function insertIdempotency(tx, input) {
  await tx.query(INSERT_IDEMPOTENCY_SQL, [
    input.idempotencyKey,
    CHECKOUT_OPERATION,
    input.owner.kind === 'account' ? input.owner.key : null,
    input.owner.kind === 'guest' ? input.owner.key : null,
    input.requestHash,
    201,
    JSON.stringify(input.response),
    input.orderId,
  ])
}

function orderSessionId(owner) {
  return owner.kind === 'guest' ? owner.key : null
}

function orderResponse(order) {
  return {
    data: {
      id: order.id,
      orderNumber: order.order_number,
      paymentStatus: order.payment_status,
      fulfillmentStatus: order.fulfillment_status,
      paymentMethod: order.payment_method,
      currency: order.currency,
      netAmount: order.net_amount,
      taxAmount: order.tax_amount,
      grossAmount: order.gross_amount,
    },
    meta: {},
  }
}

function billingSnapshot(billing) {
  return {
    first_name: billing.firstName ?? null,
    last_name: billing.lastName ?? null,
    company_name: billing.companyName ?? null,
    nip: billing.nip ?? null,
    phone: billing.phone ?? null,
    recipient: billing.recipient ?? null,
    street: billing.street,
    building_number: billing.buildingNumber,
    apartment_number: billing.apartmentNumber ?? null,
    postal_code: billing.postalCode,
    city: billing.city,
    country_code: billing.countryCode,
  }
}

function cryptoRandom() {
  return randomBytes(16).toString('hex')
}

function reject(status, code, message) {
  throw new CheckoutRejection(status, code, message)
}
