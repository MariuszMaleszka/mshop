import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerAdminOrderRoutes } from '../src/admin-orders/routes.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { HttpError } from '../src/http/errors.js'
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
        registerAdminOrderRoutes(router, { database })
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

describe('GET /api/v1/admin/orders/:id', { skip }, () => {
  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }

    if (database) {
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

  it('returns snapshot detail without secrets or writes', async () => {
    const admin = await user({ admin: true })
    const productId = await product()
    const sessionId = 'a'.repeat(64)
    const order = await insertOrder({
      method: 'online',
      gross: 350,
      sessionId,
      lines: [
        { productId, quantity: 1, unit: 100, sku: 'SKU-OLD' },
        { productId, quantity: 1, unit: 250, sku: null },
      ],
    })
    const firstPayment = await insertPayment(order.id, {
      method: 'online',
      status: 'cancelled',
      initializationStatus: 'rejected',
    })
    const currentPayment = await insertPayment(order.id, {
      method: 'online',
      status: 'pending',
      initializationStatus: 'unknown',
      providerTransactionId: 'p24-9001',
    })
    await insertReservation(order, 0, 'active')
    await insertReservation(order, 1, 'expired')
    await database.query(
      `INSERT INTO public.order_status_history (
         order_id, status_type, old_status, new_status, changed_by
       )
       VALUES ($1, 'payment', NULL, 'pending', $2)`,
      [order.id, admin.userId],
    )
    await database.query(
      `INSERT INTO public.payment_events (
         payment_id, provider, provider_event_id, event_type, payload, processed_at
       )
       VALUES
         ($1, 'przelewy24', $2, 'verification_requested', $3::jsonb, NULL),
         ($1, 'przelewy24', $4, 'verification_accepted', '{"status":"success"}'::jsonb, clock_timestamp())`,
      [
        currentPayment,
        `evt-${randomUUID()}`,
        JSON.stringify({
          sign: 'super-secret-sign',
          sessionId,
          crc: 'hidden-crc',
        }),
        `evt-${randomUUID()}`,
      ],
    )
    const before = await stamps(order.id)
    const result = await read(order.id, admin.authorization)
    const after = await stamps(order.id)
    const body = result.payload.data
    const encoded = JSON.stringify(result.payload)

    assert.equal(result.status, 200)
    assert.equal(body.order.id, order.id)
    assert.equal(body.order.paymentStatus, 'pending')
    assert.equal(body.order.fulfillmentStatus, 'new')
    assert.equal(body.order.netAmount, '350')
    assert.equal(body.order.taxAmount, '0')
    assert.equal(body.order.grossAmount, '350')
    assert.equal(body.order.currency, 'PLN')
    assert.equal(body.order.seller.nip, '5555555555')
    assert.equal(body.customer.email, order.email)
    assert.equal(body.customer.type, 'individual')
    assert.equal(body.customer.phone, '500100200')
    assert.equal(body.customer.street, 'Lipowa')
    assert.equal(body.items.length, 2)
    assert.deepEqual(
      body.items.map((item) => item.productId),
      [productId, productId],
    )
    assert.deepEqual(body.items.map((item) => item.unitGrossAmount).sort(), [
      '100',
      '250',
    ])
    assert.deepEqual(body.items.map((item) => item.sku).sort(), [
      'SKU-OLD',
      null,
    ])
    assert.equal(body.items[0].name, 'Snapshot name')
    assert.equal(body.payments.length, 2)
    assert.deepEqual(body.payments.map((payment) => payment.status).sort(), [
      'cancelled',
      'pending',
    ])
    assert.equal(
      body.payments.find((payment) => payment.id === currentPayment)
        .initializationStatus,
      'unknown',
    )
    assert.equal(
      body.payments.find((payment) => payment.id === currentPayment)
        .providerTransactionId,
      'p24-9001',
    )
    assert.equal(
      body.payments.find((payment) => payment.id === firstPayment).status,
      'cancelled',
    )
    assert.equal(body.reservations.length, 2)
    assert.deepEqual(
      body.reservations.map((reservation) => reservation.status).sort(),
      ['active', 'expired'],
    )
    assert.equal(body.history.length, 1)
    assert.equal(body.history[0].oldStatus, null)
    assert.equal(body.history[0].newStatus, 'pending')
    assert.equal(body.history[0].changedBy, admin.userId)
    assert.deepEqual(
      body.paymentEvents.map((event) => event.eventType).sort(),
      ['verification_accepted', 'verification_requested'],
    )
    assert.equal(encoded.includes('super-secret-sign'), false)
    assert.equal(encoded.includes('hidden-crc'), false)
    assert.equal(encoded.includes(sessionId), false)
    assert.equal(encoded.includes('redirectToken'), false)
    assert.equal(encoded.includes('Current catalog name'), false)
    assert.equal(
      body.items.some((item) => item.unitGrossAmount === '999'),
      false,
    )
    assert.equal(encoded.includes('not-a-billing-secret'), false)
    assert.deepEqual(before, after)
  })

  it('keeps an empty order readable and rejects bad access', async () => {
    const admin = await user({ admin: true })
    const customer = await user({ admin: false })
    const order = await insertOrder({ method: 'cash', gross: 100, lines: [] })
    const empty = await read(order.id, admin.authorization)
    const anonymous = await read(order.id, '')
    const denied = await read(order.id, customer.authorization)
    const missing = await read(randomUUID(), admin.authorization)
    const invalid = await read('not-a-uuid', admin.authorization)

    assert.equal(empty.status, 200)
    assert.deepEqual(empty.payload.data.items, [])
    assert.deepEqual(empty.payload.data.payments, [])
    assert.deepEqual(empty.payload.data.reservations, [])
    assert.deepEqual(empty.payload.data.history, [])
    assert.deepEqual(empty.payload.data.paymentEvents, [])
    assert.equal(empty.payload.data.payments[0], undefined)
    assert.equal(anonymous.status, 401)
    assert.equal(denied.status, 403)
    assert.equal(missing.status, 404)
    assert.equal(missing.payload.error.code, 'NOT_FOUND')
    assert.equal(invalid.status, 400)
    assert.equal(invalid.payload.error.code, 'VALIDATION_ERROR')
  })

  it('returns each aggregation in its explicit order', async () => {
    const admin = await user({ admin: true })
    const productId = await product()
    let order = null

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = await insertOrder({
        method: 'online',
        gross: 200,
        lines: [
          { productId, quantity: 1, unit: 100, sku: 'A' },
          { productId, quantity: 1, unit: 100, sku: 'B' },
        ],
      })

      if (candidate.itemIds[0] > candidate.itemIds[1]) {
        order = candidate
        break
      }
    }

    assert.ok(order)
    const sameTime = '2026-03-03T00:00:00.000Z'
    const earlier = '2026-03-01T00:00:00.000Z'
    const later = '2026-03-02T00:00:00.000Z'
    const firstPayment = await insertPayment(order.id, {
      method: 'online',
      status: 'cancelled',
      initializationStatus: 'rejected',
    })
    const secondPayment = await insertPayment(order.id, {
      method: 'online',
      status: 'cancelled',
      initializationStatus: 'not_started',
    })
    const thirdPayment = await insertPayment(order.id, {
      method: 'online',
      status: 'cancelled',
      initializationStatus: 'unknown',
      providerTransactionId: `p24-${randomUUID()}`,
    })
    await database.query(
      `UPDATE public.payments AS p
       SET created_at = input.created_at
       FROM (
         VALUES
           ($1::uuid, $4::timestamptz),
           ($2::uuid, $4::timestamptz),
           ($3::uuid, $5::timestamptz)
       ) AS input(id, created_at)
       WHERE p.id = input.id`,
      [firstPayment, secondPayment, thirdPayment, sameTime, earlier],
    )
    await insertReservation(order, 0, 'expired')
    await insertReservation(order, 1, 'expired')
    await database.query(
      `UPDATE public.inventory_reservations
       SET created_at = CASE order_item_id
         WHEN $2::uuid THEN $3::timestamptz
         ELSE $4::timestamptz
       END
       WHERE order_id = $1`,
      [order.id, order.itemIds[0], later, earlier],
    )
    let history = { rows: [] }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await database.query(
        'DELETE FROM public.order_status_history WHERE order_id = $1',
        [order.id],
      )
      history = await database.query(
        `INSERT INTO public.order_status_history (
           order_id, status_type, old_status, new_status, created_at
         )
         VALUES
           ($1, 'payment', NULL, 'pending', $2::timestamptz),
           ($1, 'fulfillment', NULL, 'new', $2::timestamptz)
         RETURNING id`,
        [order.id, sameTime],
      )

      if (history.rows[0].id > history.rows[1].id) {
        break
      }
    }

    assert.equal(history.rows[0].id > history.rows[1].id, true)
    const paymentId = thirdPayment
    const events = await database.query(
      `INSERT INTO public.payment_events (
         payment_id, provider, provider_event_id, event_type, payload, created_at
       )
       VALUES
         ($1, 'przelewy24', $2, 'verification_requested', '{}'::jsonb, $4::timestamptz),
         ($1, 'przelewy24', $3, 'verification_accepted', '{}'::jsonb, $5::timestamptz)
       RETURNING id, event_type`,
      [paymentId, `evt-${randomUUID()}`, `evt-${randomUUID()}`, later, earlier],
    )
    const result = await read(order.id, admin.authorization)
    const body = result.payload.data
    const tiedPayments = [firstPayment, secondPayment].sort()

    assert.equal(result.status, 200)
    assert.deepEqual(
      body.items.map((item) => item.id),
      [...order.itemIds].sort(),
    )
    assert.deepEqual(
      body.payments.map((payment) => payment.id),
      [thirdPayment, ...tiedPayments],
    )
    assert.deepEqual(
      body.reservations.map((reservation) => reservation.orderItemId),
      [order.itemIds[1], order.itemIds[0]],
    )
    assert.deepEqual(
      body.history.map((entry) => entry.id),
      history.rows.map((row) => row.id).sort(),
    )
    assert.deepEqual(
      body.paymentEvents.map((event) => event.eventType),
      ['verification_accepted', 'verification_requested'],
    )
    assert.notEqual(events.rows[0].event_type, body.paymentEvents[0].eventType)
  })

  it('does not collapse an unresolved operator state into the payment status', async () => {
    const admin = await user({ admin: true })
    const order = await insertOrder({ method: 'online', gross: 100, lines: [] })
    const paymentId = await insertPayment(order.id, {
      method: 'online',
      status: 'pending',
      initializationStatus: 'unknown',
      providerTransactionId: 'p24-unresolved',
    })
    await database.query(
      `INSERT INTO public.payment_events (
         payment_id, provider, event_type, payload
       )
       VALUES ($1, 'przelewy24', 'verification_requested', '{"sign":"unresolved-secret"}'::jsonb)`,
      [paymentId],
    )
    const result = await read(order.id, admin.authorization)
    const payment = result.payload.data.payments[0]
    const event = result.payload.data.paymentEvents[0]

    assert.equal(result.payload.data.order.paymentStatus, 'pending')
    assert.equal(payment.status, 'pending')
    assert.equal(payment.initializationStatus, 'unknown')
    assert.equal(event.eventType, 'verification_requested')
    assert.equal(event.processedAt, null)
    assert.equal(
      JSON.stringify(result.payload).includes('unresolved-secret'),
      false,
    )
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

async function product() {
  const inserted = await database.query(
    `INSERT INTO public.products (
       name, slug, description, product_type, sku, price_amount, currency,
       tax_status, vat_rate, is_active, stock_quantity
     )
     VALUES ('Current catalog name', $1, 'Current', 'physical', $2, 999, 'PLN',
       'exempt', NULL, true, 5)
     RETURNING id`,
    [`detail-${randomUUID()}`, `sku-${randomUUID()}`],
  )
  productIds.push(inserted.rows[0].id)
  return inserted.rows[0].id
}

async function insertOrder({ method, gross, lines, sessionId = null }) {
  const email = `buyer-${randomUUID()}@detail.test`
  const inserted = await database.query(
    `INSERT INTO public.orders (
       order_number, customer_email, customer_type, billing_snapshot,
       seller_tax_status_snapshot, seller_business_name_snapshot, seller_nip_snapshot,
       seller_street_snapshot, seller_building_number_snapshot, seller_postal_code_snapshot,
       seller_city_snapshot, seller_country_code_snapshot, currency, net_amount, tax_amount,
       gross_amount, payment_method, payment_status, fulfillment_status, session_id
     )
     VALUES (
       $1, $2, 'individual', $3::jsonb,
       'exempt', 'Detail Test', '5555555555', 'Lipowa', '1', '00-001', 'Warszawa', 'PL',
       'PLN', $4, 0, $4, $5, 'pending', 'new', $6
     )
     RETURNING id`,
    [
      `D${randomUUID().replaceAll('-', '')}`,
      email,
      JSON.stringify({
        phone: '500100200',
        street: 'Lipowa',
        sign: 'not-a-billing-secret',
      }),
      gross,
      method,
      sessionId,
    ],
  )
  const id = inserted.rows[0].id
  orderIds.push(id)
  const itemIds = []

  for (const line of lines) {
    const item = await database.query(
      `INSERT INTO public.order_items (
         order_id, product_id, product_name_snapshot, product_type_snapshot, sku_snapshot,
         currency, catalog_tax_status_snapshot, tax_status_snapshot, unit_gross_amount,
         quantity, line_net_amount, line_tax_amount, line_gross_amount
       )
       VALUES (
         $1, $2, 'Snapshot name', 'physical', $3, 'PLN', 'exempt', 'exempt', $4,
         $5, $6, 0, $6
       )
       RETURNING id`,
      [
        id,
        line.productId,
        line.sku,
        line.unit,
        line.quantity,
        line.unit * line.quantity,
      ],
    )
    itemIds.push(item.rows[0].id)
  }

  return { id, email, itemIds, lines }
}

async function insertPayment(orderId, payment) {
  const provider = payment.method === 'online' ? 'przelewy24' : null
  const inserted = await database.query(
    `INSERT INTO public.payments (
       order_id, method, provider, provider_transaction_id, status, amount, currency,
       initialization_status
     )
     SELECT id, payment_method, $2, $3, $4, gross_amount, currency, $5
     FROM public.orders
     WHERE id = $1
     RETURNING id`,
    [
      orderId,
      provider,
      payment.providerTransactionId ?? null,
      payment.status,
      payment.initializationStatus ?? null,
    ],
  )
  return inserted.rows[0].id
}

async function insertReservation(order, lineIndex, status) {
  const line = order.lines[lineIndex]
  await database.query(
    `INSERT INTO public.inventory_reservations (
       order_id, order_item_id, product_id, payment_method, quantity, status, expires_at
     )
     VALUES (
       $1, $2, $3, 'online', $4, $5,
       CASE WHEN $5 = 'active' THEN clock_timestamp() + interval '15 minutes' ELSE NULL END
     )`,
    [order.id, order.itemIds[lineIndex], line.productId, line.quantity, status],
  )
}

async function stamps(orderId) {
  const result = await database.query(
    `SELECT
       o.updated_at AS order_updated_at,
       (
         SELECT json_agg(p.updated_at ORDER BY p.id)
         FROM public.payments AS p
         WHERE p.order_id = o.id
       ) AS payments,
       (
         SELECT json_agg(r.updated_at ORDER BY r.id)
         FROM public.inventory_reservations AS r
         WHERE r.order_id = o.id
       ) AS reservations
     FROM public.orders AS o
     WHERE o.id = $1`,
    [orderId],
  )
  return result.rows[0]
}

async function read(orderId, authorization) {
  const headers = {}

  if (authorization) {
    headers.Authorization = authorization
  }

  const response = await fetch(`${baseUrl}/api/v1/admin/orders/${orderId}`, {
    headers,
  })
  return { status: response.status, payload: await response.json() }
}
