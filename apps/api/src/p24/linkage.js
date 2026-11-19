import {
  PAYMENT_ADVISORY_LOCK_NAMESPACE,
  paymentAdvisoryLockKey,
} from '../checkout/payment-lock.js'
import { SessionLockTimeoutError } from '../db/pool.js'
import { HttpError } from '../http/errors.js'
import {
  P24DataError,
  P24HttpError,
  P24NetworkError,
  P24ResponseError,
  P24TimeoutError,
} from './errors.js'

export const P24_NOTIFICATION_LOCK_TIMEOUT_MS = 1000

const PAYMENT_SQL = `
  SELECT
    p.id,
    p.provider,
    p.status,
    p.amount::text AS amount,
    btrim(p.currency) AS currency,
    p.provider_transaction_id,
    o.id AS order_id,
    o.payment_status
  FROM public.payments AS p
  LEFT JOIN public.orders AS o ON o.id = p.order_id
  WHERE p.id = $1::uuid
`

const EVENT_SQL = `
  SELECT
    event_type,
    payload->>'sessionId' AS session_id,
    payload->>'orderId' AS order_id,
    payload->>'amount' AS amount,
    payload->>'originAmount' AS origin_amount,
    payload->>'currency' AS currency,
    payload->>'methodId' AS method_id
  FROM public.payment_events
  WHERE payment_id = $1::uuid
    AND provider = 'przelewy24'
    AND event_type IN (
      'verification_requested',
      'verification_accepted',
      'verification_declined'
    )
  ORDER BY created_at, id
`

const LOCK_ORDER_SQL = `
  SELECT id, payment_status
  FROM public.orders
  WHERE id = $1::uuid
  FOR UPDATE
`

const LOCK_PAYMENT_SQL = `
  SELECT
    id,
    order_id,
    provider,
    status,
    amount::text AS amount,
    btrim(currency) AS currency,
    provider_transaction_id
  FROM public.payments
  WHERE id = $1::uuid
    AND order_id = $2::uuid
  FOR UPDATE
`

const LOCK_RESERVATIONS_SQL = `
  SELECT id
  FROM public.inventory_reservations
  WHERE order_id = $1::uuid
  ORDER BY id
  FOR UPDATE
`

const UPDATE_PAYMENT_SQL = `
  UPDATE public.payments
  SET status = 'paid',
      provider_transaction_id = $2,
      paid_at = clock_timestamp()
  WHERE id = $1::uuid
    AND status = 'pending'
    AND provider = 'przelewy24'
    AND refunded_amount = 0
  RETURNING id
`

const UPDATE_ORDER_SQL = `
  UPDATE public.orders
  SET payment_status = 'paid'
  WHERE id = $1::uuid
    AND payment_status = 'pending'
  RETURNING id
`

const INSERT_HISTORY_SQL = `
  INSERT INTO public.order_status_history (
    order_id, status_type, old_status, new_status, changed_by
  )
  VALUES ($1::uuid, 'payment', 'pending', 'paid', NULL)
`

const INSERT_EVENT_SQL = `
  INSERT INTO public.payment_events (
    payment_id, provider, provider_event_id, event_type, payload
  )
  VALUES ($1::uuid, 'przelewy24', NULL, $2, $3::jsonb)
`

const UNCHANGED_STATUSES = new Set([
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled',
])

export async function handlePaymentNotification(
  database,
  notification,
  {
    lockTimeoutMs = P24_NOTIFICATION_LOCK_TIMEOUT_MS,
    verifyTransaction,
    beforeVerificationRequestCommit,
    beforeFinalizationStage,
  } = {},
) {
  if (!database?.withSessionLock) {
    throw unavailable('p24.notification_read_failed')
  }

  try {
    return await database.withSessionLock(
      PAYMENT_ADVISORY_LOCK_NAMESPACE,
      paymentAdvisoryLockKey(notification.sessionId),
      (session) =>
        verifyUnderLock(session, notification, {
          verifyTransaction,
          beforeVerificationRequestCommit,
          beforeFinalizationStage,
        }),
      { timeoutMs: lockTimeoutMs },
    )
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }

    if (error instanceof SessionLockTimeoutError) {
      throw unavailable('p24.notification_lock_timeout')
    }

    if (error instanceof P24TimeoutError) {
      throw unavailable('p24.notification_verify_timeout')
    }

    if (
      error instanceof P24NetworkError ||
      error instanceof P24HttpError ||
      error instanceof P24ResponseError ||
      error instanceof P24DataError
    ) {
      throw unavailable('p24.notification_verify_failed')
    }

    throw unavailable('p24.notification_read_failed')
  }
}

async function verifyUnderLock(session, notification, options) {
  const decision = await session.transaction(async (tx) => {
    const snapshot = await readLinkage(tx, notification)
    const next = classify(snapshot, notification)

    if (next.action !== 'request') {
      return next
    }

    if (typeof options.verifyTransaction !== 'function') {
      throw unavailable('p24.notification_verify_unconfigured')
    }

    await insertEvent(tx, notification.sessionId, 'verification_requested', {
      sessionId: notification.sessionId,
      orderId: notification.orderId,
      amount: notification.amount,
      originAmount: notification.originAmount,
      currency: notification.currency,
      methodId: notification.methodId,
    })

    if (options.beforeVerificationRequestCommit) {
      await options.beforeVerificationRequestCommit()
    }

    return next
  })

  if (decision.action !== 'request') {
    return { status: decision.status }
  }

  // The adapter returns only after HTTP 200 and responseCode 0.
  // A definitive refusal list is not implemented: the OpenAPI spec names only "success".
  const verified = await options.verifyTransaction({
    sessionId: notification.sessionId,
    orderId: notification.orderId,
    amount: notification.amount,
    currency: notification.currency,
    merchantId: notification.merchantId,
    posId: notification.posId,
  })

  if (verified?.status === 'success') {
    return session.transaction((tx) =>
      finalizePayment(tx, notification, options),
    )
  }

  throw unavailable('p24.notification_verify_failed')
}

async function readLinkage(tx, notification) {
  const payments = await tx.query(PAYMENT_SQL, [notification.sessionId])
  const payment = payments.rows[0] ?? null
  const events = payment
    ? await tx.query(EVENT_SQL, [notification.sessionId])
    : { rows: [] }

  const rows = events.rows

  return {
    payment,
    events: rows.filter(
      (event) => event.event_type !== 'verification_declined',
    ),
    declined: rows.some(
      (event) => event.event_type === 'verification_declined',
    ),
  }
}

function classify(snapshot, notification) {
  const payment = snapshot.payment

  if (!payment) {
    throw new HttpError({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Payment notification could not be applied',
      logMessage: 'p24.notification_unknown',
    })
  }

  if (
    payment.id !== notification.sessionId ||
    payment.provider !== 'przelewy24' ||
    !payment.order_id ||
    payment.currency !== notification.currency ||
    payment.amount !== notification.originAmount ||
    notification.amount !== notification.originAmount ||
    (payment.provider_transaction_id !== null &&
      payment.provider_transaction_id !== notification.orderId) ||
    conflictsWithEvent(snapshot.events, notification) ||
    (payment.status === 'pending' && payment.payment_status === 'paid')
  ) {
    throw conflict()
  }

  if (
    snapshot.declined &&
    (payment.status === 'pending' || UNCHANGED_STATUSES.has(payment.status))
  ) {
    return { action: 'respond', status: 'unchanged' }
  }

  if (payment.status === 'pending' && snapshot.events.length === 0) {
    return { action: 'request' }
  }

  if (payment.status === 'pending' || UNCHANGED_STATUSES.has(payment.status)) {
    return { action: 'respond', status: 'unchanged' }
  }

  throw conflict()
}

function conflictsWithEvent(events, notification) {
  return events.some((event) => {
    if (
      event.session_id !== null &&
      event.session_id !== notification.sessionId
    ) {
      return true
    }

    if (event.order_id !== notification.orderId) {
      return true
    }

    if (event.amount !== null && event.amount !== notification.amount) {
      return true
    }

    if (
      event.origin_amount !== null &&
      event.origin_amount !== notification.originAmount
    ) {
      return true
    }

    if (event.currency !== null && event.currency !== notification.currency) {
      return true
    }

    return event.method_id !== null && event.method_id !== notification.methodId
  })
}

async function finalizePayment(tx, notification, options) {
  const located = await tx.query(PAYMENT_SQL, [notification.sessionId])
  const locatedPayment = located.rows[0]

  if (!locatedPayment?.order_id) {
    throw conflict()
  }

  const orders = await tx.query(LOCK_ORDER_SQL, [locatedPayment.order_id])
  const payments = await tx.query(LOCK_PAYMENT_SQL, [
    notification.sessionId,
    locatedPayment.order_id,
  ])
  await tx.query(LOCK_RESERVATIONS_SQL, [locatedPayment.order_id])
  const events = await tx.query(EVENT_SQL, [notification.sessionId])
  const order = orders.rows[0]
  const payment = payments.rows[0]
  const requested = events.rows.filter(
    (event) => event.event_type === 'verification_requested',
  )
  const accepted = events.rows.some(
    (event) => event.event_type === 'verification_accepted',
  )
  const declined = events.rows.some(
    (event) => event.event_type === 'verification_declined',
  )

  if (
    !order ||
    !payment ||
    payment.id !== notification.sessionId ||
    payment.provider !== 'przelewy24' ||
    payment.order_id !== order.id ||
    payment.currency !== notification.currency ||
    payment.amount !== notification.originAmount ||
    notification.amount !== notification.originAmount ||
    (payment.provider_transaction_id !== null &&
      payment.provider_transaction_id !== notification.orderId) ||
    requested.length === 0 ||
    requested.some((event) => !sameLinkage(event, notification))
  ) {
    throw conflict()
  }

  if (payment.status === 'pending' && order.payment_status === 'paid') {
    throw conflict()
  }

  if (
    declined ||
    accepted ||
    payment.status !== 'pending' ||
    order.payment_status !== 'pending'
  ) {
    if (declined || accepted || UNCHANGED_STATUSES.has(payment.status)) {
      return { status: 'unchanged' }
    }

    throw conflict()
  }

  const payload = {
    sessionId: notification.sessionId,
    orderId: notification.orderId,
    amount: notification.amount,
    originAmount: notification.originAmount,
    currency: notification.currency,
    methodId: notification.methodId,
  }

  await runStage(options, 'event')
  await insertEvent(
    tx,
    notification.sessionId,
    'verification_accepted',
    payload,
  )
  await runStage(options, 'payment')
  const paid = await tx.query(UPDATE_PAYMENT_SQL, [
    notification.sessionId,
    notification.orderId,
  ])

  if (paid.rows.length !== 1) {
    throw unavailable('p24.notification_finalize_failed')
  }

  await runStage(options, 'order')
  const paidOrder = await tx.query(UPDATE_ORDER_SQL, [order.id])

  if (paidOrder.rows.length !== 1) {
    throw unavailable('p24.notification_finalize_failed')
  }

  await runStage(options, 'history')
  await tx.query(INSERT_HISTORY_SQL, [order.id])
  return { status: 'accepted' }
}

function sameLinkage(event, notification) {
  return (
    event.session_id === notification.sessionId &&
    event.order_id === notification.orderId &&
    event.amount === notification.amount &&
    event.origin_amount === notification.originAmount &&
    event.currency === notification.currency &&
    event.method_id === notification.methodId
  )
}

function runStage(options, stage) {
  return options.beforeFinalizationStage?.(stage)
}

function insertEvent(tx, paymentId, eventType, payload) {
  return tx.query(INSERT_EVENT_SQL, [
    paymentId,
    eventType,
    JSON.stringify(payload),
  ])
}

function conflict() {
  return new HttpError({
    status: 409,
    code: 'CONFLICT',
    message: 'Payment notification could not be applied',
    logMessage: 'p24.notification_conflict',
  })
}

function unavailable(logMessage) {
  return new HttpError({
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service unavailable',
    logMessage,
  })
}
