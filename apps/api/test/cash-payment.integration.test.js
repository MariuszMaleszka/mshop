import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerCashReceiptRoutes } from '../src/cash-payment/routes.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { HttpError } from '../src/http/errors.js'
import { expireOnlineOrder } from '../src/reservation-expiry/expire.js'
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
      max: 4,
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
        registerCashReceiptRoutes(router, { database })
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
const productIds = []
const userIds = []

describe('POST /api/v1/admin/orders/:id/mark-paid', { skip }, () => {
  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }

    if (database) {
      await database.query(
        'DELETE FROM public.idempotency_keys WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      )
      await database.query(
        'DELETE FROM public.inventory_reservations WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      )
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
        'DELETE FROM public.products WHERE id = ANY($1::uuid[])',
        [productIds],
      )
      await database.query(
        'DELETE FROM public.user_roles WHERE user_id = ANY($1::uuid[])',
        [userIds],
      )
      await database.query(
        'DELETE FROM auth.users WHERE id = ANY($1::uuid[])',
        [userIds],
      )
      await database.close()
    }

    if (releaseIntegration) {
      await releaseIntegration()
    }
  })

  it('confirms cash, consumes reservations, and replays the same key', async () => {
    const admin = await user({ admin: true })
    const order = await cashOrder([
      { quantity: 2, stock: 5 },
      { quantity: 1, stock: 4 },
    ])
    const before = await availability(order.orderId)
    const key = `cash-${randomUUID()}`
    const first = await markPaid(order.orderId, admin.authorization, key)
    const stored = await snapshot(order.orderId)
    const repeat = await markPaid(order.orderId, admin.authorization, key)
    const afterRepeat = await snapshot(order.orderId)

    assert.equal(first.status, 200)
    assert.equal(first.payload.data.paymentStatus, 'paid')
    assert.equal(first.payload.data.fulfillmentStatus, 'new')
    assert.equal(first.payload.data.paymentMethod, 'cash')
    assert.equal(stored.payment_status, 'paid')
    assert.equal(stored.fulfillment_status, 'new')
    assert.equal(stored.payment_row_status, 'paid')
    assert.equal(stored.paid_at instanceof Date, true)
    assert.equal(first.payload.data.paidAt, stored.paid_at.toISOString())
    assert.deepEqual(stored.reservation_statuses, ['consumed', 'consumed'])
    assert.deepEqual(stored.stocks, [3, 3])
    assert.deepEqual(await availability(order.orderId), before)
    assert.deepEqual(stored.history, [
      {
        status_type: 'payment',
        old_status: 'pending',
        new_status: 'paid',
        changed_by: admin.userId,
      },
    ])
    assert.equal(stored.event_provider, 'manual')
    assert.equal(stored.event_type, 'cash_received')
    assert.equal(stored.event_processed instanceof Date, true)
    assert.deepEqual(repeat.payload, first.payload)
    assert.deepEqual(afterRepeat.stocks, stored.stocks)
  })

  it('rejects the same key for a different order and leaves that order pending', async () => {
    const admin = await user({ admin: true })
    const first = await cashOrder([{ quantity: 1, stock: 3 }])
    const second = await cashOrder([{ quantity: 1, stock: 3 }])
    const key = `cash-${randomUUID()}`
    const created = await markPaid(first.orderId, admin.authorization, key)
    const reused = await markPaid(second.orderId, admin.authorization, key)
    const stored = await snapshot(second.orderId)

    assert.equal(created.status, 200)
    assert.equal(reused.status, 409)
    assert.equal(reused.payload.error.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(stored.payment_status, 'pending')
    assert.deepEqual(stored.reservation_statuses, ['active'])
    assert.deepEqual(stored.stocks, [3])
  })

  it('decrements stock once when two confirmations run together', async () => {
    const admin = await user({ admin: true })
    const order = await cashOrder([{ quantity: 2, stock: 6 }])
    const results = await Promise.all([
      markPaid(order.orderId, admin.authorization, `a-${randomUUID()}`),
      markPaid(order.orderId, admin.authorization, `b-${randomUUID()}`),
    ])
    const stored = await snapshot(order.orderId)
    const statuses = results.map((result) => result.status).sort()

    assert.deepEqual(statuses, [200, 409])
    assert.equal(
      results.find((result) => result.status === 409).payload.error.code,
      'PAYMENT_NOT_PENDING',
    )
    assert.deepEqual(stored.stocks, [4])
    assert.deepEqual(stored.reservation_statuses, ['consumed'])
  })

  it('returns one stored result when the same key is submitted twice in parallel', async () => {
    const admin = await user({ admin: true })
    const order = await cashOrder([{ quantity: 2, stock: 6 }])
    const key = `same-${randomUUID()}`
    const results = await Promise.all([
      markPaid(order.orderId, admin.authorization, key),
      markPaid(order.orderId, admin.authorization, key),
    ])
    const stored = await snapshot(order.orderId)

    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200],
    )
    assert.deepEqual(results[0].payload, results[1].payload)
    assert.deepEqual(stored.stocks, [4])
    assert.deepEqual(stored.reservation_statuses, ['consumed'])
  })

  it('refuses a customer, an online order, a closed payment, and a bad reservation', async () => {
    const admin = await user({ admin: true })
    const customer = await user({ admin: false })
    const cash = await cashOrder([{ quantity: 1, stock: 2 }])
    const online = await cashOrder([
      { quantity: 1, stock: 2, method: 'online' },
    ])
    const closed = await cashOrder([
      { quantity: 1, stock: 2, paymentStatus: 'cancelled' },
    ])
    const expired = await cashOrder([
      { quantity: 1, stock: 2, reservationStatus: 'expired' },
    ])
    const missing = await cashOrder([
      { quantity: 1, stock: 2, reservation: false },
    ])
    const denied = await markPaid(
      cash.orderId,
      customer.authorization,
      'customer',
    )
    const anonymous = await markPaid(cash.orderId, '', 'anonymous')
    const notCash = await markPaid(
      online.orderId,
      admin.authorization,
      'online',
    )
    const notPending = await markPaid(
      closed.orderId,
      admin.authorization,
      'closed',
    )
    const inactive = await markPaid(
      expired.orderId,
      admin.authorization,
      'expired',
    )
    const absent = await markPaid(
      missing.orderId,
      admin.authorization,
      'missing',
    )

    assert.equal(denied.status, 403)
    assert.equal(denied.payload.error.code, 'FORBIDDEN')
    assert.equal(anonymous.status, 401)
    assert.equal(notCash.status, 409)
    assert.equal(notCash.payload.error.code, 'NOT_CASH_PAYMENT')
    assert.equal(notPending.status, 409)
    assert.equal(notPending.payload.error.code, 'PAYMENT_NOT_PENDING')
    assert.equal(inactive.status, 409)
    assert.equal(inactive.payload.error.code, 'RESERVATION_NOT_ACTIVE')
    assert.equal(absent.status, 409)
    assert.equal(absent.payload.error.code, 'RESERVATION_NOT_ACTIVE')
    assert.deepEqual((await snapshot(cash.orderId)).stocks, [2])
    assert.deepEqual((await snapshot(online.orderId)).stocks, [2])
    assert.equal((await snapshot(online.orderId)).payment_status, 'pending')
    assert.deepEqual((await snapshot(closed.orderId)).stocks, [2])
    assert.deepEqual((await snapshot(expired.orderId)).reservation_statuses, [
      'expired',
    ])
    assert.deepEqual((await snapshot(expired.orderId)).stocks, [2])
    assert.equal((await snapshot(missing.orderId)).payment_status, 'pending')
  })

  it('does not leave a partial stock change when one product cannot be consumed', async () => {
    const admin = await user({ admin: true })
    const order = await cashOrder([
      { quantity: 2, stock: 5 },
      { quantity: 1, stock: 0 },
    ])
    const result = await markPaid(order.orderId, admin.authorization, 'short')
    const stored = await snapshot(order.orderId)

    assert.equal(result.status, 409)
    assert.equal(result.payload.error.code, 'INSUFFICIENT_STOCK')
    assert.equal(stored.payment_status, 'pending')
    assert.deepEqual(stored.reservation_statuses, ['active', 'active'])
    assert.deepEqual([...stored.stocks].sort(), [0, 5])
    assert.equal(stored.history.length, 0)
    assert.equal(stored.event_type, null)
  })

  it('returns not found for an unknown order without writing a key', async () => {
    const admin = await user({ admin: true })
    const missing = '11111111-1111-4111-8111-111111111111'
    const result = await markPaid(
      missing,
      admin.authorization,
      `missing-${randomUUID()}`,
    )
    const keys = await database.query(
      `SELECT id FROM public.idempotency_keys WHERE idempotency_key LIKE 'missing-%' AND user_id = $1`,
      [admin.userId],
    )

    assert.equal(result.status, 404)
    assert.equal(result.payload.error.code, 'NOT_FOUND')
    assert.equal(keys.rows.length, 0)
  })

  it('leaves a cash reservation for the expiry worker and then confirms it', async () => {
    const admin = await user({ admin: true })
    const order = await cashOrder([{ quantity: 1, stock: 2 }])
    const expired = await expireOnlineOrder(database, order.orderId)
    const before = await snapshot(order.orderId)
    const result = await markPaid(
      order.orderId,
      admin.authorization,
      'after-worker',
    )
    const after = await snapshot(order.orderId)

    assert.equal(expired.transaction, false)
    assert.equal(expired.expired, 0)
    assert.deepEqual(before.reservation_statuses, ['active'])
    assert.equal(result.status, 200)
    assert.deepEqual(after.reservation_statuses, ['consumed'])
    assert.deepEqual(after.stocks, [1])
    assert.equal(after.fulfillment_status, 'new')
  })
})

async function user({ admin }) {
  const userId = randomUUID()
  const token = randomUUID()
  userIds.push(userId)
  tokens.set(token, userId)
  await database.query('INSERT INTO auth.users (id) VALUES ($1)', [userId])

  if (admin) {
    await database.query(
      `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`,
      [userId],
    )
  }

  return { userId, authorization: `Bearer ${token}` }
}

async function cashOrder(lines) {
  const method = lines[0].method ?? 'cash'
  const paymentStatus = lines[0].paymentStatus ?? 'pending'
  const gross = lines.reduce((sum, line) => sum + line.quantity * 100, 0)
  const order = await database.query(
    `INSERT INTO public.orders (
       order_number, customer_email, customer_type, billing_snapshot,
       seller_tax_status_snapshot, seller_business_name_snapshot, seller_nip_snapshot,
       seller_street_snapshot, seller_building_number_snapshot, seller_postal_code_snapshot,
       seller_city_snapshot, seller_country_code_snapshot, currency, net_amount, tax_amount,
       gross_amount, payment_method, payment_status, fulfillment_status
     )
     VALUES (
       $1, $2, 'individual', '{"street":"Lipowa"}'::jsonb,
       'exempt', 'Cash Test', '5555555555', 'Lipowa', '1', '00-001', 'Warszawa', 'PL',
       'PLN', $3, 0, $3, $4, $5, 'new'
     )
     RETURNING id`,
    [
      `M${randomUUID().replaceAll('-', '')}`,
      `buyer-${randomUUID()}@cash.test`,
      gross,
      method,
      paymentStatus,
    ],
  )
  const orderId = order.rows[0].id
  orderIds.push(orderId)
  const provider = method === 'online' ? 'przelewy24' : null
  const initialization = method === 'online' ? 'not_started' : null
  await database.query(
    `INSERT INTO public.payments (
       order_id, method, provider, provider_transaction_id, status, amount, currency,
       initialization_status
     )
     VALUES ($1, $2, $3, NULL, $4, $5, 'PLN', $6)`,
    [orderId, method, provider, paymentStatus, gross, initialization],
  )

  for (const line of lines) {
    const product = await database.query(
      `INSERT INTO public.products (
         name, slug, description, product_type, sku, price_amount, currency,
         tax_status, vat_rate, is_active, stock_quantity
       )
       VALUES ('Cash product', $1, 'Cash product', 'physical', $2, 100, 'PLN',
         'exempt', NULL, true, $3)
       RETURNING id`,
      [`cash-${randomUUID()}`, `sku-${randomUUID()}`, line.stock],
    )
    const productId = product.rows[0].id
    productIds.push(productId)
    const item = await database.query(
      `INSERT INTO public.order_items (
         order_id, product_id, product_name_snapshot, product_type_snapshot, currency,
         catalog_tax_status_snapshot, tax_status_snapshot, unit_gross_amount, quantity,
         line_net_amount, line_tax_amount, line_gross_amount
       )
       VALUES (
         $1, $2, 'Cash product', 'physical', 'PLN', 'exempt', 'exempt', 100, $3,
         $4, 0, $4
       )
       RETURNING id`,
      [orderId, productId, line.quantity, line.quantity * 100],
    )

    if (line.reservation !== false) {
      const status = line.reservationStatus ?? 'active'
      await database.query(
        `INSERT INTO public.inventory_reservations (
           order_id, order_item_id, product_id, payment_method, quantity, status, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'online' THEN clock_timestamp() + interval '15 minutes' ELSE NULL END)`,
        [orderId, item.rows[0].id, productId, method, line.quantity, status],
      )
    }
  }

  return { orderId }
}

async function markPaid(orderId, authorization, key) {
  const headers = { 'Idempotency-Key': key }

  if (authorization) {
    headers.Authorization = authorization
  }

  const response = await fetch(
    `${baseUrl}/api/v1/admin/orders/${orderId}/mark-paid`,
    { method: 'POST', headers },
  )
  return { status: response.status, payload: await response.json() }
}

async function snapshot(orderId) {
  const result = await database.query(
    `SELECT
       o.payment_status,
       o.fulfillment_status,
       p.status AS payment_row_status,
       p.paid_at,
       (
         SELECT json_agg(r.status ORDER BY r.id)
         FROM public.inventory_reservations AS r
         WHERE r.order_id = o.id
       ) AS reservation_statuses,
       (
         SELECT json_agg(pr.stock_quantity ORDER BY oi.id)
         FROM public.order_items AS oi
         JOIN public.products AS pr ON pr.id = oi.product_id
         WHERE oi.order_id = o.id
       ) AS stocks,
       (
         SELECT json_agg(
           json_build_object(
             'status_type', h.status_type,
             'old_status', h.old_status,
             'new_status', h.new_status,
             'changed_by', h.changed_by
           )
           ORDER BY h.created_at, h.id
         )
         FROM public.order_status_history AS h
         WHERE h.order_id = o.id
           AND h.old_status IS NOT NULL
       ) AS history,
       e.provider AS event_provider,
       e.event_type,
       e.processed_at AS event_processed
     FROM public.orders AS o
     JOIN public.payments AS p ON p.order_id = o.id
     LEFT JOIN public.payment_events AS e ON e.payment_id = p.id
     WHERE o.id = $1`,
    [orderId],
  )
  const row = result.rows[0]
  return {
    ...row,
    reservation_statuses: row.reservation_statuses ?? [],
    stocks: row.stocks ?? [],
    history: row.history ?? [],
  }
}

async function availability(orderId) {
  const result = await database.query(
    `SELECT pr.stock_quantity - COALESCE((
       SELECT sum(r.quantity)
       FROM public.inventory_reservations AS r
       WHERE r.product_id = pr.id
         AND r.status = 'active'
     ), 0) AS available
     FROM public.order_items AS oi
     JOIN public.products AS pr ON pr.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [orderId],
  )
  return result.rows.map((row) => Number(row.available))
}
