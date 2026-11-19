import {
  PAYMENT_ADVISORY_LOCK_NAMESPACE,
  paymentAdvisoryLockKey,
} from './payment-lock.js'
import { transactionPanelUrl } from '../p24/redirect.js'

const P24_EMAIL_MAX = 50

const LOAD_SQL = `
  SELECT
    o.id AS order_id,
    o.order_number,
    o.payment_status AS order_payment_status,
    o.fulfillment_status,
    o.payment_method,
    btrim(o.currency) AS currency,
    o.net_amount::text AS net_amount,
    o.tax_amount::text AS tax_amount,
    o.gross_amount::text AS gross_amount,
    o.customer_email,
    o.billing_snapshot,
    p.id AS payment_id,
    p.status AS payment_financial_status,
    p.initialization_status,
    p.redirect_token,
    p.provider,
    p.provider_transaction_id,
    p.amount::text AS amount,
    btrim(p.currency) AS payment_currency
  FROM public.orders AS o
  JOIN public.payments AS p
    ON p.order_id = o.id
   AND p.provider = 'przelewy24'
  WHERE o.id = $1::uuid
`

const MARK_UNKNOWN_SQL = `
  UPDATE public.payments
  SET initialization_status = 'unknown'
  WHERE id = $1::uuid
    AND order_id = $2::uuid
    AND provider = 'przelewy24'
    AND status = 'pending'
    AND initialization_status = 'not_started'
    AND redirect_token IS NULL
    AND provider_transaction_id IS NULL
    AND amount = $3::bigint
    AND btrim(currency) = $4
  RETURNING id
`

const SAVE_TOKEN_SQL = `
  UPDATE public.payments
  SET initialization_status = 'registered',
      redirect_token = $5
  WHERE id = $1::uuid
    AND order_id = $2::uuid
    AND provider = 'przelewy24'
    AND status = 'pending'
    AND initialization_status = 'unknown'
    AND redirect_token IS NULL
    AND provider_transaction_id IS NULL
    AND amount = $3::bigint
    AND btrim(currency) = $4
  RETURNING id
`

export async function settleOnlinePayment(database, dependencies, { orderId }) {
  return database.withSessionLock(
    PAYMENT_ADVISORY_LOCK_NAMESPACE,
    paymentAdvisoryLockKey(await paymentIdForOrder(database, orderId)),
    async (session) => {
      const current = await readPayment(session, orderId)

      if (canRegister(current, dependencies)) {
        const started = await session.transaction((tx) =>
          markUnknown(tx, current),
        )

        if (started) {
          await registerOnce(session, dependencies, current)
        }
      } else if (
        current.initialization_status === 'unknown' &&
        dependencies.client
      ) {
        await lookupOnly(dependencies.client, current.payment_id)
      }

      return {
        status: 201,
        body: onlineResponse(await readPayment(session, orderId), dependencies),
      }
    },
  )
}

async function paymentIdForOrder(database, orderId) {
  const result = await database.query(
    `
      SELECT id
      FROM public.payments
      WHERE order_id = $1::uuid
        AND provider = 'przelewy24'
    `,
    [orderId],
  )

  if (result.rows.length !== 1) {
    throw new Error('Online payment could not be read')
  }

  return result.rows[0].id
}

async function readPayment(session, orderId) {
  const result = await session.query(LOAD_SQL, [orderId])

  if (result.rows.length !== 1) {
    throw new Error('Online payment could not be read')
  }

  return result.rows[0]
}

function canRegister(row, dependencies) {
  return (
    dependencies.environment === 'sandbox' &&
    typeof dependencies.urlReturn === 'string' &&
    typeof dependencies.urlStatus === 'string' &&
    dependencies.client &&
    row.provider === 'przelewy24' &&
    row.payment_financial_status === 'pending' &&
    row.initialization_status === 'not_started' &&
    row.redirect_token === null &&
    row.provider_transaction_id === null &&
    row.payment_currency === row.currency &&
    row.amount === row.gross_amount &&
    typeof row.customer_email === 'string' &&
    row.customer_email.length >= 3 &&
    row.customer_email.length <= P24_EMAIL_MAX &&
    countryCode(row) !== null
  )
}

async function markUnknown(tx, row) {
  const result = await tx.query(MARK_UNKNOWN_SQL, [
    row.payment_id,
    row.order_id,
    row.amount,
    row.payment_currency,
  ])

  return result.rows.length === 1
}

async function registerOnce(session, dependencies, row) {
  let token = null

  try {
    const registered = await dependencies.client.registerTransaction({
      sessionId: row.payment_id,
      amount: row.amount,
      currency: row.payment_currency,
      description: `Order ${row.order_number}`,
      email: row.customer_email,
      country: countryCode(row),
      language: 'pl',
      urlReturn: dependencies.urlReturn,
      urlStatus: dependencies.urlStatus,
    })
    token = registered?.token
  } catch {
    return
  }

  if (!usableToken(token)) {
    return
  }

  try {
    await session.transaction((tx) => writeRegistrationToken(tx, row, token))
  } catch {
    // The order remains. The next replay reads the current payment row.
  }
}

export async function writeRegistrationToken(tx, row, token) {
  const result = await tx.query(SAVE_TOKEN_SQL, [
    row.payment_id,
    row.order_id,
    row.amount,
    row.payment_currency,
    token,
  ])

  return result.rows.length
}

async function lookupOnly(client, paymentId) {
  try {
    await client.getTransactionBySessionId(paymentId)
  } catch {
    // Lookup cannot restore a token and must not start another registration.
  }
}

function onlineResponse(row, dependencies) {
  const payment = {
    initializationStatus: row.initialization_status,
  }
  const redirectUrl = dependencies.publishRedirect
    ? transactionPanelUrl(dependencies.environment, row.redirect_token)
    : null

  if (redirectUrl) {
    payment.redirectUrl = redirectUrl
  }

  return {
    data: {
      id: row.order_id,
      orderNumber: row.order_number,
      paymentStatus: row.order_payment_status,
      fulfillmentStatus: row.fulfillment_status,
      paymentMethod: row.payment_method,
      currency: row.currency,
      netAmount: row.net_amount,
      taxAmount: row.tax_amount,
      grossAmount: row.gross_amount,
      payment,
    },
    meta: {},
  }
}

function countryCode(row) {
  const snapshot = row.billing_snapshot
  const code =
    snapshot && typeof snapshot === 'object' ? snapshot.country_code : null

  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : null
}

function usableToken(token) {
  return (
    typeof token === 'string' &&
    token.length >= 1 &&
    token.length <= 2048 &&
    !/\s/.test(token)
  )
}
