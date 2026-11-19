import { SessionLockTimeoutError } from '../db/pool.js'
import {
  PAYMENT_ADVISORY_LOCK_NAMESPACE,
  paymentAdvisoryLockKey,
} from '../checkout/payment-lock.js'

export const EXPIRY_PAGE_SIZE = 50
export const EXPIRY_TRANSACTION_LIMIT = 50
export const EXPIRY_ATTEMPT_LIMIT = 200
export const EXPIRY_LOCK_TIMEOUT_MS = 1000
export const EXPIRY_INTERVAL_MS = 30000

const CANDIDATE_SQL = `
  SELECT order_id, min(expires_at) AS oldest_expires_at
  FROM public.inventory_reservations
  WHERE status = 'active'
    AND payment_method = 'online'
    AND expires_at <= clock_timestamp()
    AND ($1::uuid[] IS NULL OR NOT (order_id = ANY($1::uuid[])))
  GROUP BY order_id
  HAVING (
    $2::timestamptz IS NULL
    OR (min(expires_at), order_id) > ($2::timestamptz, $3::uuid)
  )
  ORDER BY min(expires_at), order_id
  LIMIT $4::integer
`

const PAYMENT_SQL = `
  SELECT id
  FROM public.payments
  WHERE order_id = $1::uuid
    AND provider = 'przelewy24'
`

const LOCK_ORDER_SQL = `
  SELECT id, payment_status
  FROM public.orders
  WHERE id = $1::uuid
  FOR UPDATE
`

const LOCK_PAYMENT_SQL = `
  SELECT id, order_id, status, provider
  FROM public.payments
  WHERE id = $1::uuid
    AND order_id = $2::uuid
  FOR UPDATE
`

const LOCK_RESERVATIONS_SQL = `
  SELECT id, expires_at <= clock_timestamp() AS due
  FROM public.inventory_reservations
  WHERE order_id = $1::uuid
    AND status = 'active'
    AND payment_method = 'online'
  ORDER BY id
  FOR UPDATE
`

const EXPIRE_SQL = `
  UPDATE public.inventory_reservations
  SET status = 'expired'
  WHERE id = ANY($1::uuid[])
    AND order_id = $2::uuid
    AND status = 'active'
    AND payment_method = 'online'
    AND expires_at <= clock_timestamp()
  RETURNING id
`

export class ReservationExpiryCountError extends Error {
  constructor() {
    super('Reservation expiry updated an unexpected number of rows')
    this.name = 'ReservationExpiryCountError'
    this.code = 'UPDATE_COUNT'
  }
}

export async function runExpiryPass(database, options = {}) {
  const pageSize = options.pageSize ?? EXPIRY_PAGE_SIZE
  const transactionLimit = options.transactionLimit ?? EXPIRY_TRANSACTION_LIMIT
  const attemptLimit = options.attemptLimit ?? EXPIRY_ATTEMPT_LIMIT
  const lockTimeoutMs = options.lockTimeoutMs ?? EXPIRY_LOCK_TIMEOUT_MS
  const shouldStop = options.shouldStop ?? (() => false)
  const logger = options.logger
  const skipped = []
  let cursorAt = null
  let cursorId = null
  let attempts = 0
  let transactions = 0
  let candidates = 0
  let expiredOrders = 0
  let expiredReservations = 0

  while (transactions < transactionLimit && attempts < attemptLimit) {
    if (shouldStop()) {
      break
    }

    const page = await readCandidates(database, {
      skipped,
      cursorAt,
      cursorId,
      pageSize,
    })

    if (page.length === 0) {
      break
    }

    for (const candidate of page) {
      if (
        shouldStop() ||
        transactions >= transactionLimit ||
        attempts >= attemptLimit
      ) {
        break
      }

      attempts += 1
      candidates += 1
      skipped.push(candidate.order_id)
      cursorAt = candidate.oldest_expires_at
      cursorId = candidate.order_id

      try {
        const result = await expireOnlineOrder(database, candidate.order_id, {
          lockTimeoutMs,
          logger,
        })

        if (result.transaction) {
          transactions += 1
        }

        if (result.expired > 0) {
          expiredOrders += 1
          expiredReservations += result.expired
        }
      } catch (error) {
        if (error instanceof SessionLockTimeoutError) {
          logger?.error('reservation_expiry.lock_timeout')
        } else {
          logger?.error('reservation_expiry.order_failed')
        }
      }
    }
  }

  logger?.info('reservation_expiry.pass', {
    detail: `candidates=${candidates} expiredOrders=${expiredOrders} expiredReservations=${expiredReservations}`,
  })

  return {
    attempts,
    transactions,
    candidates,
    expiredOrders,
    expiredReservations,
  }
}

export async function expireOnlineOrder(database, orderId, options = {}) {
  const payments = await database.query(PAYMENT_SQL, [orderId])

  if (payments.rows.length !== 1) {
    options.logger?.error('reservation_expiry.payment_count')
    return { transaction: false, expired: 0 }
  }

  try {
    const expired = await database.withSessionLock(
      PAYMENT_ADVISORY_LOCK_NAMESPACE,
      paymentAdvisoryLockKey(payments.rows[0].id),
      (session) =>
        session.transaction((tx) =>
          expireLockedOrder(tx, orderId, payments.rows[0].id),
        ),
      { timeoutMs: options.lockTimeoutMs ?? EXPIRY_LOCK_TIMEOUT_MS },
    )

    return { transaction: true, expired }
  } catch (error) {
    if (error instanceof ReservationExpiryCountError) {
      options.logger?.error('reservation_expiry.update_count')
      return { transaction: true, expired: 0 }
    }

    throw error
  }
}

async function readCandidates(
  database,
  { skipped, cursorAt, cursorId, pageSize },
) {
  const result = await database.query(CANDIDATE_SQL, [
    skipped.length === 0 ? null : skipped,
    cursorAt,
    cursorId,
    pageSize,
  ])

  return result.rows
}

async function expireLockedOrder(tx, orderId, paymentId) {
  const orders = await tx.query(LOCK_ORDER_SQL, [orderId])
  const payments = await tx.query(LOCK_PAYMENT_SQL, [paymentId, orderId])
  const reservations = await tx.query(LOCK_RESERVATIONS_SQL, [orderId])
  const order = orders.rows[0]
  const payment = payments.rows[0]
  const due =
    reservations.rows.length > 0 &&
    reservations.rows.every((reservation) => reservation.due === true)

  if (
    !order ||
    !payment ||
    payment.order_id !== orderId ||
    payment.provider !== 'przelewy24' ||
    order.payment_status === 'paid' ||
    payment.status === 'paid' ||
    payment.status === 'partially_refunded' ||
    !due
  ) {
    return 0
  }

  const updated = await tx.query(EXPIRE_SQL, [
    reservations.rows.map((reservation) => reservation.id),
    orderId,
  ])

  if (updated.rows.length !== reservations.rows.length) {
    throw new ReservationExpiryCountError()
  }

  return updated.rows.length
}
