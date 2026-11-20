import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { HttpError } from '../src/http/errors.js'
import { registerOrderRoutes } from '../src/orders/routes.js'
import { hashGuestSessionId } from '../src/session/guest-session.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

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
const releaseIntegration = available
  ? await holdIntegrationDatabase(databaseUrl)
  : null
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    })
  : null
const tokens = new Map()
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const app = database
  ? createApp(config, {
      database,
      accessTokens: {
        async verifyAccessToken(token) {
          const userId = tokens.get(token)

          if (!userId) {
            throw new HttpError({
              status: 401,
              code: 'UNAUTHORIZED',
              message: 'Authentication required',
              logMessage: 'auth.invalid_token',
            })
          }

          return userId
        },
      },
      registerRoutes(router) {
        registerOrderRoutes(router, { database })
      },
    })
  : null

const server = app
  ? await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
  : null
const baseUrl = server ? `http://127.0.0.1:${server.address().port}` : ''
const orderIds = []
const userIds = []

describe('GET /api/v1/orders/:id', { skip }, () => {
  after(async () => {
    if (database) {
      await database.query(
        'DELETE FROM public.payments WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      )
      await database.query(
        'DELETE FROM public.order_items WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      )
      await database.query(
        'DELETE FROM public.orders WHERE id = ANY($1::uuid[])',
        [orderIds],
      )
      await database.query(
        'DELETE FROM auth.users WHERE id = ANY($1::uuid[])',
        [userIds],
      )
      await database.close()
    }

    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }

    await releaseIntegration?.()
  })

  it('returns only the guest order for its session hash', async () => {
    const owner = guest()
    const other = guest()
    const order = await insertOrder({ sessionId: owner.hash, method: 'online' })
    await insertItem(order.id, 'Etui ochronne', 4999, 2, 9998)
    await insertItem(order.id, 'Organizer', 7900, 1, 7900)
    await insertPayment(order.id, 'not_started')
    await database.query(
      `INSERT INTO public.payment_events (payment_id, provider, event_type, payload)
       SELECT id, 'przelewy24', 'verification_requested', '{"secret":"hidden"}'::jsonb
       FROM public.payments WHERE order_id = $1`,
      [order.id],
    )
    const before = await snapshot(order.id)
    const response = await getOrder(order.id, { cookie: owner.cookie })
    const missing = await getOrder(randomUUID(), { cookie: owner.cookie })
    const foreign = await getOrder(order.id, { cookie: other.cookie })
    const after = await snapshot(order.id)

    assert.equal(response.status, 200)
    assert.deepEqual(response.payload.meta, {})
    assert.equal(response.payload.data.id, order.id)
    assert.equal(response.payload.data.paymentStatus, 'pending')
    assert.equal(response.payload.data.paymentMethod, 'online')
    assert.equal(response.payload.data.currency, 'PLN')
    assert.equal(response.payload.data.grossAmount, '17998')
    assert.equal(
      response.payload.data.payment.initializationStatus,
      'not_started',
    )
    assert.equal(response.payload.data.items.length, 2)
    assert.equal(
      response.payload.data.items.some(
        (item) =>
          item.name === 'Etui ochronne' &&
          item.quantity === 2 &&
          item.unitGrossAmount === '4999' &&
          item.lineGrossAmount === '9998' &&
          item.currency === 'PLN',
      ),
      true,
    )
    assertPublic(response.payload, owner.raw)
    assert.equal(
      JSON.stringify(response.payload).includes('verification_requested'),
      false,
    )
    assert.equal(JSON.stringify(response.payload).includes('hidden'), false)
    assert.deepEqual(missing.payload, foreign.payload)
    assert.equal(missing.status, 404)
    assert.equal(foreign.status, 404)
    assert.deepEqual(after, before)
  })

  it('requires the existing guest session policy and hides an unowned order', async () => {
    const owner = guest()
    const order = await insertOrder({ sessionId: null, userId: null })
    const missingCookie = await getOrder(order.id)
    const invalidCookie = await getOrder(order.id, {
      cookie: 'shop_guest_session=not-a-session',
    })
    const ownedUuid = await getOrder(order.id, { cookie: owner.cookie })

    assert.equal(missingCookie.status, 401)
    assert.equal(missingCookie.payload.error.code, 'UNAUTHORIZED')
    assert.equal(invalidCookie.status, 401)
    assert.equal(invalidCookie.payload.error.code, 'UNAUTHORIZED')
    assert.equal(ownedUuid.status, 404)
    assert.equal(ownedUuid.payload.error.code, 'NOT_FOUND')
  })

  it('returns an account order only to its token', async () => {
    const owner = await account()
    const other = await account()
    const order = await insertOrder({ userId: owner.userId, method: 'cash' })
    await insertItem(order.id, 'Zestaw podróżny', 12900, 1, 12900)
    const response = await getOrder(order.id, {
      authorization: owner.authorization,
    })
    const foreign = await getOrder(order.id, {
      authorization: other.authorization,
    })
    const invalid = await getOrder(order.id, {
      authorization: 'Bearer not-a-token',
      cookie: guest().cookie,
    })
    const missing = await getOrder(randomUUID(), {
      authorization: owner.authorization,
    })

    assert.equal(response.status, 200)
    assert.equal(response.payload.data.paymentMethod, 'cash')
    assert.equal(response.payload.data.payment, undefined)
    assert.equal(response.payload.data.items[0].name, 'Zestaw podróżny')
    assert.equal(foreign.status, 404)
    assert.deepEqual(foreign.payload, missing.payload)
    assert.equal(invalid.status, 401)
    assert.equal(invalid.payload.error.code, 'UNAUTHORIZED')
  })

  it('shows a later database status without writing during the read', async () => {
    const owner = guest()
    const order = await insertOrder({ sessionId: owner.hash, method: 'online' })
    await insertPayment(order.id, 'unknown')
    const first = await getOrder(order.id, { cookie: owner.cookie })
    const before = await snapshot(order.id)
    const second = await getOrder(order.id, { cookie: owner.cookie })
    const reread = await snapshot(order.id)

    await database.query(
      `UPDATE public.orders SET payment_status = 'paid' WHERE id = $1`,
      [order.id],
    )
    await database.query(
      `UPDATE public.payments
       SET status = 'paid', paid_at = clock_timestamp()
       WHERE order_id = $1`,
      [order.id],
    )
    const changed = await getOrder(order.id, { cookie: owner.cookie })
    const afterRead = await snapshot(order.id)
    const changedAgain = await snapshot(order.id)

    assert.equal(first.payload.data.paymentStatus, 'pending')
    assert.equal(first.payload.data.payment.initializationStatus, 'unknown')
    assert.deepEqual(second.payload, first.payload)
    assert.deepEqual(reread, before)
    assert.equal(changed.payload.data.paymentStatus, 'paid')
    assert.equal(changed.payload.data.payment.initializationStatus, 'unknown')
    assert.equal(
      JSON.stringify(changed.payload).includes('operator-order'),
      false,
    )
    assert.deepEqual(changedAgain, afterRead)
  })
})

function guest() {
  const raw = randomBytes(32).toString('hex')
  return {
    raw,
    hash: hashGuestSessionId(raw),
    cookie: `shop_guest_session=${raw}`,
  }
}

async function account() {
  const userId = randomUUID()
  const token = randomUUID()
  userIds.push(userId)
  tokens.set(token, userId)
  await database.query('INSERT INTO auth.users (id) VALUES ($1)', [userId])
  return { userId, authorization: `Bearer ${token}` }
}

async function insertOrder({
  sessionId = null,
  userId = null,
  method = 'online',
}) {
  const gross = method === 'cash' ? 12900 : 17998
  const result = await database.query(
    `INSERT INTO public.orders (
       order_number, customer_email, customer_type, billing_snapshot,
       seller_tax_status_snapshot, seller_business_name_snapshot, seller_nip_snapshot,
       seller_street_snapshot, seller_building_number_snapshot, seller_postal_code_snapshot,
       seller_city_snapshot, seller_country_code_snapshot, currency, net_amount, tax_amount,
       gross_amount, payment_method, payment_status, fulfillment_status, user_id, session_id
     )
     VALUES (
       $1, $2, 'individual', '{"street":"Lipowa","phone":"500","nip":"5555555555"}'::jsonb,
       'exempt', 'Hidden Seller', '5555555555', 'Lipowa', '1', '00-001', 'Warszawa', 'PL',
       'PLN', $3, 0, $3, $4, 'pending', 'new', $5::uuid, $6::char(64)
     )
     RETURNING id`,
    [
      `R${randomUUID().replaceAll('-', '')}`,
      `buyer-${randomUUID()}@orders.test`,
      gross,
      method,
      userId,
      sessionId,
    ],
  )
  orderIds.push(result.rows[0].id)
  return result.rows[0]
}

async function insertItem(orderId, name, unit, quantity, line) {
  await database.query(
    `INSERT INTO public.order_items (
       order_id, product_name_snapshot, product_type_snapshot, currency,
       catalog_tax_status_snapshot, tax_status_snapshot, unit_gross_amount, quantity,
       line_net_amount, line_tax_amount, line_gross_amount
     )
     VALUES ($1, $2, 'physical', 'PLN', 'exempt', 'exempt', $3, $4, $5, 0, $5)`,
    [orderId, name, unit, quantity, line],
  )
}

async function insertPayment(orderId, initializationStatus) {
  await database.query(
    `INSERT INTO public.payments (
       order_id, method, provider, status, amount, currency, initialization_status,
       provider_transaction_id
     )
     SELECT id, 'online', 'przelewy24', 'pending', gross_amount, currency, $2,
            CASE WHEN $2 = 'unknown' THEN 'operator-order' ELSE NULL END
     FROM public.orders WHERE id = $1`,
    [orderId, initializationStatus],
  )
}

async function snapshot(orderId) {
  const result = await database.query(
    `SELECT o.payment_status, o.fulfillment_status, o.updated_at,
            p.status AS payment_row_status, p.initialization_status, p.updated_at AS payment_updated_at,
            p.provider_transaction_id, p.redirect_token,
            (SELECT count(*) FROM public.payment_events e WHERE e.payment_id = p.id) AS events
     FROM public.orders AS o
     LEFT JOIN public.payments AS p ON p.order_id = o.id
     WHERE o.id = $1`,
    [orderId],
  )
  return result.rows[0]
}

async function getOrder(orderId, { cookie, authorization } = {}) {
  const headers = {}

  if (cookie) {
    headers.cookie = cookie
  }

  if (authorization) {
    headers.authorization = authorization
  }

  const response = await fetch(`${baseUrl}/api/v1/orders/${orderId}`, {
    headers,
  })
  return { status: response.status, payload: await response.json() }
}

function assertPublic(payload, rawSession) {
  const keys = collectKeys(payload)
  const hidden = [
    'email',
    'phone',
    'nip',
    'billing',
    'session_id',
    'sessionId',
    'redirectToken',
    'redirectUrl',
    'providerTransactionId',
    'provider_transaction_id',
    'token',
    'street',
    'seller',
    'payload',
    'idempotency',
  ]

  for (const key of hidden) {
    assert.equal(keys.includes(key), false, key)
  }

  const text = JSON.stringify(payload)
  assert.equal(text.includes(rawSession), false)
  assert.equal(text.includes('secret-token'), false)
  assert.equal(text.includes('operator-order'), false)
  assert.equal(text.includes('Lipowa'), false)
  assert.equal(text.includes('Hidden Seller'), false)
}

function collectKeys(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, found)
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key)
      collectKeys(child, found)
    }
  }

  return found
}
