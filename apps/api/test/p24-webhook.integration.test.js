import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import pg from 'pg'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import {
  PAYMENT_ADVISORY_LOCK_NAMESPACE,
  paymentAdvisoryLockKey,
} from '../src/checkout/payment-lock.js'
import { createDatabase } from '../src/db/pool.js'
import {
  P24HttpError,
  P24NetworkError,
  P24ResponseError,
  P24TimeoutError,
} from '../src/p24/errors.js'
import {
  P24_WEBHOOK_PATH,
  registerP24WebhookRoutes,
} from '../src/p24/webhook-routes.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const CRC = 'crc-webhook-secret'
const p24 = { merchantId: '10', posId: '11', crcKey: CRC }

function localDatabaseUrl() {
  const configured = process.env.DATABASE_URL

  if (!configured) {
    return 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  }

  try {
    const url = new URL(configured)
    return LOCAL_HOSTS.has(url.hostname) ? configured : null
  } catch {
    return null
  }
}

const databaseUrl = localDatabaseUrl()
const probe = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
    })
  : null
let available = false

if (probe) {
  try {
    const client = await probe.connect()
    await client.query('SELECT 1')
    client.release()
    available = true
  } catch {
    available = false
  } finally {
    await probe.end()
  }
}

const skip = available ? false : 'local database is not available'
const notificationOrderIds = new Map()
let nextNotificationOrder = 5000
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    })
  : null
const releaseIntegration = available
  ? await holdIntegrationDatabase(databaseUrl)
  : null
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
let server
let baseUrl
let externalCalls = 0
const verifyCalls = []
const hooks = {
  beforeCommit: null,
  verify(input) {
    verifyCalls.push(input)
    return hooks.impl(input)
  },
  impl() {
    return { status: 'success' }
  },
}
const originalFetch = globalThis.fetch

function sha384(value) {
  return createHash('sha384').update(value, 'utf8').digest('hex')
}

function signedBody(fields) {
  const sign = sha384(
    `{"merchantId":${p24.merchantId},"posId":${p24.posId},"sessionId":${JSON.stringify(fields.sessionId)},"amount":${fields.amount},"originAmount":${fields.originAmount},"currency":${JSON.stringify(fields.currency)},"orderId":${fields.orderId},"methodId":1,"statement":"","crc":${JSON.stringify(CRC)}}`,
  )
  return JSON.stringify({
    merchantId: 10,
    posId: 11,
    sessionId: fields.sessionId,
    currency: fields.currency,
    methodId: 1,
    statement: '',
    sign,
  }).replace(
    '"sessionId"',
    `"amount":${fields.amount},"originAmount":${fields.originAmount},"orderId":${fields.orderId},"sessionId"`,
  )
}

async function post(body) {
  const response = await originalFetch(`${baseUrl}${P24_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return { status: response.status, payload: await response.json() }
}

describe('Przelewy24 notification linkage', { concurrency: 1, skip }, () => {
  beforeEach(() => {
    verifyCalls.length = 0
    hooks.beforeCommit = null
    hooks.beforeStage = null
    hooks.impl = () => ({ status: 'success' })
  })

  before(async () => {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('przelewy24')) {
        externalCalls += 1
      }

      return originalFetch(url, options)
    }
    const app = createApp(config, {
      database,
      registerRoutes(router) {
        registerP24WebhookRoutes(router, {
          p24,
          database,
          lockTimeoutMs: 200,
          verifyTransaction: (input) => hooks.verify(input),
          beforeVerificationRequestCommit: () => hooks.beforeCommit?.(),
          beforeFinalizationStage: (stage) => hooks.beforeStage?.(stage),
        })
      },
    })
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    globalThis.fetch = originalFetch
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }

    if (database) {
      await database.query(
        `DELETE FROM public.inventory_reservations
         WHERE order_id IN (
           SELECT id FROM public.orders WHERE customer_email LIKE '%@webhook.test'
         )`,
      )
      await database.query(
        `DELETE FROM public.payment_events
         WHERE payment_id IN (
           SELECT id FROM public.payments
           WHERE order_id IN (
             SELECT id FROM public.orders WHERE customer_email LIKE '%@webhook.test'
           )
         )`,
      )
      await database.query(
        `DELETE FROM public.payments
         WHERE order_id IN (
           SELECT id FROM public.orders WHERE customer_email LIKE '%@webhook.test'
         )`,
      )
      await database.query(
        `DELETE FROM public.orders WHERE customer_email LIKE '%@webhook.test'`,
      )
      await database.query(
        `DELETE FROM public.products WHERE slug LIKE 'webhook-%'`,
      )
      await database.close()
    }

    await releaseIntegration?.()
  })

  it('returns 404 for an unknown session and does not write', async () => {
    const before = await counts()
    const result = await post(bodyFor(randomUUID()))

    assert.equal(result.status, 404)
    assert.equal(result.payload.error.code, 'NOT_FOUND')
    assert.deepEqual(await counts(), before)
    assert.equal(externalCalls, 0)
  })

  it('rejects another provider, amount, currency, and origin amount without writes', async () => {
    const stripe = await createOrder({ provider: 'stripe' })
    const currency = await createOrder()
    const amount = await createOrder()
    const origin = await createOrder()
    const before = await counts()

    assert.equal(
      (await post(bodyFor(stripe.paymentId, { currency: 'EUR' }))).status,
      409,
    )
    assert.equal(
      (await post(bodyFor(currency.paymentId, { currency: 'EUR' }))).status,
      409,
    )
    assert.equal(
      (await post(bodyFor(amount.paymentId, { amount: '90' }))).status,
      409,
    )
    assert.equal(
      (
        await post(
          bodyFor(origin.paymentId, { amount: '101', originAmount: '101' }),
        )
      ).status,
      409,
    )
    assert.deepEqual(await counts(), before)
    assert.equal((await snapshot(stripe.paymentId)).status, 'pending')
    assert.equal((await snapshot(currency.paymentId)).currency, 'PLN')
  })

  it('rejects an orderId that differs from the payment or a stored event', async () => {
    const stored = await createOrder({ providerTransactionId: '222' })
    const event = await createOrder()
    await database.query(
      `INSERT INTO public.payment_events (
         payment_id, provider, event_type, payload
       )
       VALUES (
         $1, 'przelewy24', 'verification_requested',
         jsonb_build_object('orderId', '333', 'amount', '100', 'originAmount', '100', 'currency', 'PLN')
       )`,
      [event.paymentId],
    )
    const before = await snapshot(event.paymentId)

    assert.equal(
      (await post(bodyFor(stored.paymentId, { orderId: '444' }))).status,
      409,
    )
    assert.equal((await post(bodyFor(event.paymentId))).status, 409)
    assert.equal(
      (await snapshot(stored.paymentId)).provider_transaction_id,
      '222',
    )
    assert.deepEqual(await snapshot(event.paymentId), before)
  })

  it('leaves paid, refunded, and partially refunded payments unchanged', async () => {
    const paid = await createOrder({
      paymentStatus: 'paid',
      providerTransactionId: '1000',
    })
    const partial = await createOrder({ paymentStatus: 'partially_refunded' })
    const refunded = await createOrder({ paymentStatus: 'refunded' })

    for (const order of [paid, partial, refunded]) {
      const before = await snapshot(order.paymentId)
      const result = await post(
        bodyFor(order.paymentId, {
          orderId: order.providerTransactionId ?? '1000',
        }),
      )

      assert.equal(result.status, 202)
      assert.equal(result.payload.data.status, 'unchanged')
      assert.deepEqual(await snapshot(order.paymentId), before)
    }

    assert.equal(externalCalls, 0)
    assert.equal(verifyCalls.length, 0)
  })

  it('does not confirm a pending payment when the order is already paid', async () => {
    const order = await createOrder({ orderStatus: 'paid' })
    const before = await snapshot(order.paymentId)
    const result = await post(bodyFor(order.paymentId))

    assert.equal(result.status, 409)
    assert.deepEqual(await snapshot(order.paymentId), before)
    assert.equal(verifyCalls.length, 0)
  })

  it('returns 503 when the payment lock times out and then accepts the same notification', async () => {
    const order = await createOrder()
    const holder = new pg.Client({ connectionString: databaseUrl })
    await holder.connect()
    await holder.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [
      PAYMENT_ADVISORY_LOCK_NAMESPACE,
      paymentAdvisoryLockKey(order.paymentId),
    ])

    try {
      const before = await snapshot(order.paymentId)
      const blocked = await post(bodyFor(order.paymentId))

      assert.equal(blocked.status, 503)
      assert.deepEqual(await snapshot(order.paymentId), before)
    } finally {
      await holder.query(
        'SELECT pg_advisory_unlock($1::integer, $2::integer)',
        [
          PAYMENT_ADVISORY_LOCK_NAMESPACE,
          paymentAdvisoryLockKey(order.paymentId),
        ],
      )
      await holder.end()
    }

    const accepted = await post(bodyFor(order.paymentId))
    assert.equal(accepted.status, 202)
    assert.equal(accepted.payload.data.status, 'accepted')
    assert.equal(accepted.payload.data.orderId, order.notificationOrderId)
    assert.equal((await snapshot(order.paymentId)).status, 'paid')
    assert.equal((await snapshot(order.paymentId)).payment_status, 'paid')
    assert.equal(externalCalls, 0)
    assert.equal(verifyCalls.length, 1)
    assert.deepEqual(
      (await events(order.paymentId)).map((event) => event.event_type),
      ['verification_requested', 'verification_accepted'],
    )
  })

  it('serializes two notifications and verifies once', async () => {
    const order = await createOrder()
    const results = await Promise.all([
      post(bodyFor(order.paymentId)),
      post(bodyFor(order.paymentId)),
    ])
    const statuses = results.map((result) => result.payload.data.status).sort()

    assert.deepEqual(
      results.map((result) => result.status),
      [202, 202],
    )
    assert.deepEqual(statuses, ['accepted', 'unchanged'])
    assert.equal(verifyCalls.length, 1)
    assert.equal((await snapshot(order.paymentId)).status, 'paid')
    assert.equal((await snapshot(order.paymentId)).payment_status, 'paid')
    assert.equal((await snapshot(order.paymentId)).history, '1')
    assert.deepEqual(
      (await events(order.paymentId)).map((event) => event.event_type),
      ['verification_requested', 'verification_accepted'],
    )
    assert.equal(externalCalls, 0)
  })

  it('commits verification_requested before verify and finalizes after success', async () => {
    const order = await createOrder()
    const observer = new pg.Client({ connectionString: databaseUrl })
    await observer.connect()
    let during = null

    hooks.impl = async (input) => {
      const rows = await observer.query(
        `SELECT provider_event_id, event_type, payload
         FROM public.payment_events
         WHERE payment_id = $1
         ORDER BY created_at, id`,
        [order.paymentId],
      )
      const payment = await observer.query(
        `SELECT status FROM public.payments WHERE id = $1`,
        [order.paymentId],
      )
      const lock = await observer.query(
        'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked',
        [
          PAYMENT_ADVISORY_LOCK_NAMESPACE,
          paymentAdvisoryLockKey(order.paymentId),
        ],
      )
      if (lock.rows[0].locked === true) {
        await observer.query(
          'SELECT pg_advisory_unlock($1::integer, $2::integer)',
          [
            PAYMENT_ADVISORY_LOCK_NAMESPACE,
            paymentAdvisoryLockKey(order.paymentId),
          ],
        )
      }
      during = {
        rows: rows.rows,
        locked: lock.rows[0].locked,
        input,
        paymentStatus: payment.rows[0].status,
      }
      return { status: 'success' }
    }

    try {
      const result = await post(bodyFor(order.paymentId))
      const stored = await events(order.paymentId)
      const row = await snapshot(order.paymentId)

      assert.equal(result.status, 202)
      assert.equal(result.payload.data.status, 'accepted')
      assert.equal(result.payload.data.status === 'paid', false)
      assert.equal(during.locked, false)
      assert.equal(during.paymentStatus, 'pending')
      assert.equal(during.rows.length, 1)
      assert.equal(during.rows[0].event_type, 'verification_requested')
      assert.equal(during.rows[0].provider_event_id, null)
      assert.deepEqual(during.rows[0].payload, {
        sessionId: order.paymentId,
        orderId: order.notificationOrderId,
        amount: '100',
        originAmount: '100',
        currency: 'PLN',
        methodId: '1',
      })
      assert.equal(during.input.sessionId, order.paymentId)
      assert.equal(during.input.orderId, order.notificationOrderId)
      assert.equal(during.input.amount, '100')
      assert.equal(during.input.currency, 'PLN')
      assert.equal(during.input.merchantId, '10')
      assert.equal(during.input.posId, '11')
      assert.equal(typeof during.input.orderId, 'string')
      assert.equal(typeof during.input.amount, 'string')
      assert.deepEqual(
        stored.map((event) => event.event_type),
        ['verification_requested', 'verification_accepted'],
      )
      assert.equal(stored[0].provider_event_id, null)
      assert.equal(stored[1].provider_event_id, null)
      assert.equal(row.status, 'paid')
      assert.equal(row.payment_status, 'paid')
      assert.equal(row.provider_transaction_id, order.notificationOrderId)
      assert.equal(row.paid_at_set, 'true')
      assert.equal(row.history, '1')
      assert.equal(row.fulfillment_status, 'new')
      assert.equal(row.reservations, '0')
      assert.equal(JSON.stringify(stored).includes(CRC), false)
    } finally {
      await observer.end()
    }

    const replay = await post(bodyFor(order.paymentId))
    assert.equal(replay.status, 202)
    assert.equal(replay.payload.data.status, 'unchanged')
    assert.equal(verifyCalls.length, 1)
    assert.equal(externalCalls, 0)
  })

  it('does not verify when a verification event already exists', async () => {
    const requested = await createOrder()
    const accepted = await createOrder()

    for (const [paymentId, eventType] of [
      [requested.paymentId, 'verification_requested'],
      [accepted.paymentId, 'verification_accepted'],
    ]) {
      await database.query(
        `INSERT INTO public.payment_events (
           payment_id, provider, event_type, payload
         )
         VALUES (
           $1, 'przelewy24', $2,
           jsonb_build_object(
             'sessionId', $3::text,
             'orderId', $4::text,
             'amount', '100',
             'originAmount', '100',
             'currency', 'PLN',
             'methodId', '1'
           )
         )`,
        [paymentId, eventType, paymentId, notificationOrderIds.get(paymentId)],
      )
      const before = await snapshot(paymentId)
      const result = await post(bodyFor(paymentId))

      assert.equal(result.status, 202)
      assert.equal(result.payload.data.status, 'unchanged')
      assert.deepEqual(await snapshot(paymentId), before)
    }

    assert.equal(verifyCalls.length, 0)
    assert.equal(externalCalls, 0)
  })

  it('does not verify failed or cancelled payments', async () => {
    const failed = await createOrder({ paymentStatus: 'failed' })
    const cancelled = await createOrder({ paymentStatus: 'cancelled' })

    for (const order of [failed, cancelled]) {
      const before = await snapshot(order.paymentId)
      const result = await post(bodyFor(order.paymentId))

      assert.equal(result.status, 202)
      assert.equal(result.payload.data.status, 'unchanged')
      assert.deepEqual(await snapshot(order.paymentId), before)
    }

    assert.equal(verifyCalls.length, 0)
  })

  it('keeps verification_requested after an ambiguous verify failure', async () => {
    const failures = [
      new P24TimeoutError(),
      new P24NetworkError(),
      new P24HttpError(500),
      new P24ResponseError('bad'),
    ]

    for (const failure of failures) {
      const order = await createOrder()
      hooks.impl = () => {
        throw failure
      }
      const result = await post(bodyFor(order.paymentId))
      const stored = await events(order.paymentId)
      const row = await snapshot(order.paymentId)

      assert.equal(result.status, 503)
      assert.equal(result.payload.error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(JSON.stringify(result.payload).includes('bad'), false)
      assert.deepEqual(
        stored.map((event) => event.event_type),
        ['verification_requested'],
      )
      assert.equal(stored[0].provider_event_id, null)
      assert.equal(row.status, 'pending')
      assert.equal(row.payment_status, 'pending')
      verifyCalls.length = 0
    }

    assert.equal(externalCalls, 0)
  })

  it('records a declined verification without changing payment status', async () => {
    const order = await createOrder()
    hooks.impl = () => ({ status: 'rejected' })
    const result = await post(bodyFor(order.paymentId))
    const stored = await events(order.paymentId)

    assert.equal(result.status, 202)
    assert.equal(result.payload.data.status, 'unchanged')
    assert.equal(JSON.stringify(result.payload).includes('rejected'), false)
    assert.deepEqual(
      stored.map((event) => event.event_type),
      ['verification_requested', 'verification_declined'],
    )
    assert.equal(stored[1].provider_event_id, null)
    assert.deepEqual(stored[1].payload, { status: 'rejected' })
    assert.equal((await snapshot(order.paymentId)).status, 'pending')

    const replay = await post(bodyFor(order.paymentId))
    assert.equal(replay.payload.data.status, 'unchanged')
    assert.equal(verifyCalls.length, 1)
  })

  it('rolls back verification_requested when commit does not happen', async () => {
    const order = await createOrder()
    hooks.beforeCommit = () => {
      throw new Error('stop-before-commit')
    }
    const result = await post(bodyFor(order.paymentId))

    assert.equal(result.status, 503)
    assert.equal(
      JSON.stringify(result.payload).includes('stop-before-commit'),
      false,
    )
    assert.equal(verifyCalls.length, 0)
    assert.deepEqual(await events(order.paymentId), [])
    assert.equal((await snapshot(order.paymentId)).status, 'pending')
    assert.equal(externalCalls, 0)
  })

  it('finalizes a payment with expired reservations and writes status history', async () => {
    const order = await createOrder()
    const stock = await createReservations(order)
    const result = await post(bodyFor(order.paymentId))
    const history = await database.query(
      `SELECT status_type, old_status, new_status, changed_by::text
       FROM public.order_status_history
       WHERE order_id = $1`,
      [order.orderId],
    )
    const reservations = await database.query(
      `SELECT status FROM public.inventory_reservations
       WHERE order_id = $1
       ORDER BY status`,
      [order.orderId],
    )
    const product = await database.query(
      `SELECT stock_quantity FROM public.products WHERE id = $1`,
      [stock.productId],
    )
    const row = await snapshot(order.paymentId)

    assert.equal(result.status, 202)
    assert.equal(result.payload.data.status, 'accepted')
    assert.equal(row.status, 'paid')
    assert.equal(row.payment_status, 'paid')
    assert.equal(row.provider_transaction_id, order.notificationOrderId)
    assert.equal(row.paid_at_set, 'true')
    assert.equal(row.fulfillment_status, 'new')
    assert.deepEqual(history.rows, [
      {
        status_type: 'payment',
        old_status: 'pending',
        new_status: 'paid',
        changed_by: null,
      },
    ])
    assert.deepEqual(
      reservations.rows.map((reservation) => reservation.status),
      ['active', 'expired'],
    )
    assert.equal(product.rows[0].stock_quantity, 8)
    assert.equal(externalCalls, 0)
  })

  it('rolls back every finalization write when one stage fails', async () => {
    for (const stage of ['event', 'payment', 'order', 'history']) {
      const order = await createOrder()
      hooks.beforeStage = (current) => {
        if (current === stage) {
          throw new Error(`stop-${stage}`)
        }
      }
      const result = await post(bodyFor(order.paymentId))
      const row = await snapshot(order.paymentId)

      assert.equal(result.status, 503, stage)
      assert.equal(
        JSON.stringify(result.payload).includes(`stop-${stage}`),
        false,
      )
      assert.equal(row.status, 'pending', stage)
      assert.equal(row.payment_status, 'pending', stage)
      assert.equal(row.provider_transaction_id, null, stage)
      assert.equal(row.paid_at_set, 'false', stage)
      assert.equal(row.history, '0', stage)
      assert.deepEqual(
        (await events(order.paymentId)).map((event) => event.event_type),
        ['verification_requested'],
        stage,
      )
    }

    assert.equal(externalCalls, 0)
  })

  it('does not finalize when linkage changes after verify returns', async () => {
    const order = await createOrder()
    hooks.impl = async () => {
      await database.query(
        `UPDATE public.payments
         SET provider_transaction_id = '2222'
         WHERE id = $1`,
        [order.paymentId],
      )
      return { status: 'success' }
    }
    const result = await post(bodyFor(order.paymentId))
    const row = await snapshot(order.paymentId)

    assert.equal(result.status, 409)
    assert.equal(row.status, 'pending')
    assert.equal(row.provider_transaction_id, '2222')
    assert.equal(row.history, '0')
    assert.deepEqual(
      (await events(order.paymentId)).map((event) => event.event_type),
      ['verification_requested'],
    )

    const replay = await post(bodyFor(order.paymentId))
    assert.equal(replay.status, 409)
    assert.equal(verifyCalls.length, 1)
    assert.equal(externalCalls, 0)
  })

  it('keeps verification_requested when finalization rolls back and does not verify again', async () => {
    const order = await createOrder()
    hooks.beforeStage = () => {
      throw new Error('stop-before-final-commit')
    }
    const failed = await post(bodyFor(order.paymentId))

    assert.equal(failed.status, 503)
    assert.equal(
      JSON.stringify(failed.payload).includes('stop-before-final-commit'),
      false,
    )
    assert.deepEqual(
      (await events(order.paymentId)).map((event) => event.event_type),
      ['verification_requested'],
    )
    assert.equal((await snapshot(order.paymentId)).status, 'pending')

    hooks.beforeStage = null
    const replay = await post(bodyFor(order.paymentId))
    assert.equal(replay.status, 202)
    assert.equal(replay.payload.data.status, 'unchanged')
    assert.equal(verifyCalls.length, 1)
    assert.equal((await snapshot(order.paymentId)).status, 'pending')
    assert.equal(externalCalls, 0)
  })
})

function bodyFor(
  sessionId,
  {
    amount = '100',
    originAmount = '100',
    currency = 'PLN',
    orderId = notificationOrderIds.get(sessionId) ?? '1000',
  } = {},
) {
  return signedBody({ sessionId, amount, originAmount, currency, orderId })
}

async function createOrder({
  provider = 'przelewy24',
  paymentStatus = 'pending',
  orderStatus = 'pending',
  providerTransactionId = null,
} = {}) {
  const notificationOrderId =
    providerTransactionId ?? String(nextNotificationOrder++)
  const gross = 100
  const order = await database.query(
    `INSERT INTO public.orders (
       order_number, customer_email, customer_type, billing_snapshot,
       seller_tax_status_snapshot, seller_business_name_snapshot,
       seller_nip_snapshot, seller_street_snapshot, seller_building_number_snapshot,
       seller_postal_code_snapshot, seller_city_snapshot, seller_country_code_snapshot,
       currency, net_amount, tax_amount, gross_amount, payment_method, payment_status,
       fulfillment_status
     )
     VALUES (
       $1, $2, 'individual', '{}'::jsonb, 'exempt', 'Webhook Seller',
       '5555555555', 'Lipowa', '1', '00-001', 'Warszawa', 'PL',
       'PLN', $3, 0, $3, 'online', $4, 'new'
     )
     RETURNING id`,
    [
      `W${randomUUID().replaceAll('-', '')}`,
      `buyer-${randomUUID()}@webhook.test`,
      gross,
      orderStatus,
    ],
  )
  const payment = await database.query(
    `INSERT INTO public.payments (
       order_id, method, provider, status, amount, currency, paid_at,
       refunded_amount, initialization_status, provider_transaction_id
     )
     VALUES (
       $1, 'online', $2, $3, $4::bigint, 'PLN',
       CASE WHEN $3 IN ('paid', 'partially_refunded', 'refunded') THEN clock_timestamp() ELSE NULL END,
       CASE
         WHEN $3 = 'partially_refunded' THEN 40::bigint
         WHEN $3 = 'refunded' THEN $4::bigint
         ELSE 0::bigint
       END,
       CASE WHEN $2 = 'przelewy24' THEN 'not_started' ELSE NULL END,
       $5
     )
     RETURNING id`,
    [order.rows[0].id, provider, paymentStatus, gross, providerTransactionId],
  )

  notificationOrderIds.set(payment.rows[0].id, notificationOrderId)

  return {
    orderId: order.rows[0].id,
    paymentId: payment.rows[0].id,
    providerTransactionId,
    notificationOrderId,
  }
}

async function createReservations(order) {
  const product = await database.query(
    `INSERT INTO public.products (
       name, slug, description, product_type, sku, price_amount, currency,
       tax_status, vat_rate, is_active, stock_quantity
     )
     VALUES (
       'Webhook product', $1, 'Webhook product', 'service', $2, 100, 'PLN',
       'exempt', NULL, true, 8
     )
     RETURNING id`,
    [`webhook-${randomUUID()}`, `sku-${randomUUID()}`],
  )
  const productId = product.rows[0].id

  for (const status of ['expired', 'active']) {
    const item = await database.query(
      `INSERT INTO public.order_items (
         order_id, product_id, product_name_snapshot, product_type_snapshot,
         sku_snapshot, currency, catalog_tax_status_snapshot,
         catalog_vat_rate_snapshot, tax_status_snapshot, vat_rate_snapshot,
         unit_gross_amount, quantity, line_net_amount, line_tax_amount,
         line_gross_amount
       )
       VALUES (
         $1, $2, 'Webhook product', 'service', 'sku', 'PLN', 'exempt', NULL,
         'exempt', NULL, 100, 1, 100, 0, 100
       )
       RETURNING id`,
      [order.orderId, productId],
    )
    await database.query(
      `INSERT INTO public.inventory_reservations (
         order_id, order_item_id, product_id, payment_method, quantity, status, expires_at
       )
       VALUES (
         $1, $2, $3, 'online', 1, $4,
         CASE WHEN $4 = 'active' THEN clock_timestamp() + interval '15 minutes' ELSE clock_timestamp() - interval '1 minute' END
       )`,
      [order.orderId, item.rows[0].id, productId, status],
    )
  }

  return { productId }
}

async function snapshot(paymentId) {
  const result = await database.query(
    `SELECT
       p.status,
       p.amount::text AS amount,
       btrim(p.currency) AS currency,
       p.provider_transaction_id,
       p.refunded_amount::text AS refunded_amount,
       o.payment_status,
       o.fulfillment_status,
       (p.paid_at IS NOT NULL)::text AS paid_at_set,
       (SELECT count(*)::text FROM public.payment_events WHERE payment_id = p.id) AS events,
       (SELECT count(*)::text FROM public.order_status_history WHERE order_id = o.id) AS history,
       (SELECT count(*)::text FROM public.inventory_reservations WHERE order_id = o.id) AS reservations
     FROM public.payments AS p
     JOIN public.orders AS o ON o.id = p.order_id
     WHERE p.id = $1`,
    [paymentId],
  )
  return result.rows[0]
}

async function events(paymentId) {
  const result = await database.query(
    `SELECT provider_event_id, event_type, payload
     FROM public.payment_events
     WHERE payment_id = $1
     ORDER BY created_at, id`,
    [paymentId],
  )
  return result.rows
}

async function counts() {
  const result = await database.query(
    `SELECT
       (SELECT count(*)::text FROM public.orders WHERE customer_email LIKE '%@webhook.test') AS orders,
       (SELECT count(*)::text FROM public.payments
         WHERE order_id IN (
           SELECT id FROM public.orders WHERE customer_email LIKE '%@webhook.test'
         )) AS payments,
       (SELECT count(*)::text FROM public.payment_events
         WHERE payment_id IN (
           SELECT id FROM public.payments
           WHERE order_id IN (
             SELECT id FROM public.orders WHERE customer_email LIKE '%@webhook.test'
           )
         )) AS events`,
  )
  return result.rows[0]
}
