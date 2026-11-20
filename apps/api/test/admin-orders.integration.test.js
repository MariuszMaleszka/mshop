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
const userIds = []

describe('GET /api/v1/admin/orders', { skip }, () => {
  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }

    if (database) {
      await database.query(
        'DELETE FROM public.order_items WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      )
      await database.query(
        'DELETE FROM public.payments WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      )
      await database.query(
        'DELETE FROM public.orders WHERE id = ANY($1::uuid[])',
        [orderIds],
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

  it('returns one row per order for an administrator', async () => {
    const admin = await user({ admin: true })
    const marker = markerOf()
    const order = await insertOrder({
      marker,
      suffix: 'visible',
      items: 2,
      payment: true,
      billingStreet: 'Secret Street 7',
      billingPhone: '500100200',
    })
    const before = await database.query(
      'SELECT updated_at FROM public.orders WHERE id = $1',
      [order.id],
    )
    const result = await list(admin.authorization, { search: marker })
    const after = await database.query(
      'SELECT updated_at FROM public.orders WHERE id = $1',
      [order.id],
    )
    const row = result.payload.data[0]
    const encoded = JSON.stringify(result.payload)

    assert.equal(result.status, 200)
    assert.equal(result.payload.data.length, 1)
    assert.equal(row.id, order.id)
    assert.equal(row.orderNumber, order.orderNumber)
    assert.equal(row.customer.email, order.email)
    assert.equal(row.customer.type, 'individual')
    assert.equal(row.grossAmount, '200')
    assert.equal(row.currency, 'PLN')
    assert.equal(row.paymentMethod, 'cash')
    assert.equal(row.paymentStatus, 'pending')
    assert.equal(row.fulfillmentStatus, 'new')
    assert.equal(typeof row.createdAt, 'string')
    assert.deepEqual(Object.keys(row).sort(), [
      'createdAt',
      'currency',
      'customer',
      'fulfillmentStatus',
      'grossAmount',
      'id',
      'orderNumber',
      'paymentMethod',
      'paymentStatus',
    ])
    assert.equal(encoded.includes('Secret Street 7'), false)
    assert.equal(encoded.includes('500100200'), false)
    assert.equal(encoded.includes('session'), false)
    assert.equal(encoded.includes('idempotency'), false)
    assert.equal(encoded.includes(order.sellerNip), false)
    assert.deepEqual(before.rows[0].updated_at, after.rows[0].updated_at)
    assert.equal(result.payload.meta.total, 1)
    assert.equal(result.payload.meta.page, 1)
    assert.equal(result.payload.meta.limit, 20)
    assert.equal(result.payload.meta.totalPages, 1)
  })

  it('rejects an anonymous caller and a customer', async () => {
    const customer = await user({ admin: false })
    const anonymous = await list('', { search: markerOf() })
    const denied = await list(customer.authorization, { search: markerOf() })

    assert.equal(anonymous.status, 401)
    assert.equal(denied.status, 403)
  })

  it('returns an empty page when nothing matches', async () => {
    const admin = await user({ admin: true })
    const result = await list(admin.authorization, { search: markerOf() })

    assert.equal(result.status, 200)
    assert.deepEqual(result.payload.data, [])
    assert.deepEqual(result.payload.meta, {
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    })
  })

  it('pages a filtered set and rejects a limit above 100', async () => {
    const admin = await user({ admin: true })
    const marker = markerOf()
    await insertOrder({ marker, suffix: 'c-page' })
    await insertOrder({ marker, suffix: 'a-page' })
    await insertOrder({ marker, suffix: 'b-page' })
    const first = await list(admin.authorization, {
      search: marker,
      page: 1,
      limit: 2,
      sortBy: 'orderNumber',
      sortOrder: 'asc',
    })
    const second = await list(admin.authorization, {
      search: marker,
      page: 2,
      limit: 2,
      sortBy: 'orderNumber',
      sortOrder: 'asc',
    })
    const tooHigh = await list(admin.authorization, { limit: 101 })
    const zero = await list(admin.authorization, { limit: 0, page: 0 })
    const largest = await list(admin.authorization, {
      search: marker,
      limit: 100,
    })

    assert.deepEqual(
      first.payload.data.map((row) => row.orderNumber.slice(-6)),
      ['a-page', 'b-page'],
    )
    assert.deepEqual(
      second.payload.data.map((row) => row.orderNumber.slice(-6)),
      ['c-page'],
    )
    assert.equal(first.payload.meta.total, 3)
    assert.equal(first.payload.meta.totalPages, 2)
    assert.equal(second.payload.meta.page, 2)
    assert.equal(tooHigh.status, 400)
    assert.equal(tooHigh.payload.error.code, 'VALIDATION_ERROR')
    assert.equal(zero.status, 400)
    assert.equal(largest.status, 200)
    assert.equal(largest.payload.meta.limit, 100)
  })

  it('filters by number, status, and method together and apart', async () => {
    const admin = await user({ admin: true })
    const marker = markerOf()
    const cash = await insertOrder({
      marker,
      suffix: 'cash-new',
      paymentStatus: 'pending',
      fulfillmentStatus: 'new',
      method: 'cash',
    })
    await insertOrder({
      marker,
      suffix: 'cash-paid',
      paymentStatus: 'paid',
      fulfillmentStatus: 'processing',
      method: 'cash',
    })
    const online = await insertOrder({
      marker,
      suffix: 'online-new',
      paymentStatus: 'pending',
      fulfillmentStatus: 'completed',
      method: 'online',
    })
    const byNumber = await list(admin.authorization, {
      search: cash.orderNumber,
    })
    const byPayment = await list(admin.authorization, {
      search: marker,
      paymentStatus: 'pending',
    })
    const byFulfillment = await list(admin.authorization, {
      search: marker,
      fulfillmentStatus: 'completed',
    })
    const byMethod = await list(admin.authorization, {
      search: marker,
      paymentMethod: 'online',
    })
    const combined = await list(admin.authorization, {
      search: marker,
      paymentStatus: 'pending',
      fulfillmentStatus: 'new',
      paymentMethod: 'cash',
    })
    const unknown = await list(admin.authorization, {
      paymentStatus: 'shipped',
      sortBy: 'email',
      sortOrder: 'sideways',
    })

    assert.deepEqual(
      byNumber.payload.data.map((row) => row.id),
      [cash.id],
    )
    assert.equal(byNumber.payload.meta.total, 1)
    assert.deepEqual(ids(byPayment).sort(), [cash.id, online.id].sort())
    assert.equal(byPayment.payload.meta.total, 2)
    assert.deepEqual(ids(byFulfillment), [online.id])
    assert.deepEqual(ids(byMethod), [online.id])
    assert.deepEqual(ids(combined), [cash.id])
    assert.equal(combined.payload.meta.total, 1)
    assert.equal(unknown.status, 400)
    assert.equal(unknown.payload.error.code, 'VALIDATION_ERROR')
  })

  it('sorts both ways and keeps equal dates stable', async () => {
    const admin = await user({ admin: true })
    const marker = markerOf()
    const createdAt = '2026-01-15T10:00:00.000Z'
    const first = await insertOrder({
      marker,
      suffix: 'same-a',
      createdAt,
    })
    const second = await insertOrder({
      marker,
      suffix: 'same-b',
      createdAt,
    })
    const ascending = await list(admin.authorization, {
      search: marker,
      sortBy: 'createdAt',
      sortOrder: 'asc',
      limit: 1,
      page: 1,
    })
    const next = await list(admin.authorization, {
      search: marker,
      sortBy: 'createdAt',
      sortOrder: 'asc',
      limit: 1,
      page: 2,
    })
    const byNumber = await list(admin.authorization, {
      search: marker,
      sortBy: 'orderNumber',
      sortOrder: 'desc',
    })
    const expected = [first.id, second.id].sort()

    assert.equal(ascending.payload.data[0].id, expected[0])
    assert.equal(next.payload.data[0].id, expected[1])
    assert.deepEqual(
      byNumber.payload.data.map((row) => row.orderNumber),
      [second.orderNumber, first.orderNumber].sort().reverse(),
    )
  })
})

function ids(result) {
  return result.payload.data.map((row) => row.id)
}

function markerOf() {
  return `L${randomUUID().replaceAll('-', '')}`
}

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

async function insertOrder({
  marker,
  suffix,
  method = 'cash',
  paymentStatus = 'pending',
  fulfillmentStatus = 'new',
  createdAt,
  items = 0,
  payment = false,
  billingStreet = 'Lipowa',
  billingPhone = null,
}) {
  const orderNumber = `${marker}-${suffix}`
  const email = `buyer-${randomUUID()}@orders.test`
  const sellerNip = '5555555555'
  const inserted = await database.query(
    `INSERT INTO public.orders (
       order_number, customer_email, customer_type, billing_snapshot,
       seller_tax_status_snapshot, seller_business_name_snapshot, seller_nip_snapshot,
       seller_street_snapshot, seller_building_number_snapshot, seller_postal_code_snapshot,
       seller_city_snapshot, seller_country_code_snapshot, currency, net_amount, tax_amount,
       gross_amount, payment_method, payment_status, fulfillment_status, created_at
     )
     VALUES (
       $1, $2, 'individual', $3::jsonb,
       'exempt', 'List Test', $4, 'Lipowa', '1', '00-001', 'Warszawa', 'PL',
       'PLN', 200, 0, 200, $5, $6, $7, COALESCE($8::timestamptz, clock_timestamp())
     )
     RETURNING id`,
    [
      orderNumber,
      email,
      JSON.stringify({ street: billingStreet, phone: billingPhone }),
      sellerNip,
      method,
      paymentStatus,
      fulfillmentStatus,
      createdAt ?? null,
    ],
  )
  const id = inserted.rows[0].id
  orderIds.push(id)

  if (payment) {
    await database.query(
      `INSERT INTO public.payments (
         order_id, method, provider, provider_transaction_id, status, amount, currency,
         initialization_status
       )
       VALUES ($1, 'cash', NULL, NULL, 'pending', 200, 'PLN', NULL)`,
      [id],
    )
  }

  for (let index = 0; index < items; index += 1) {
    await database.query(
      `INSERT INTO public.order_items (
         order_id, product_name_snapshot, product_type_snapshot, currency,
         catalog_tax_status_snapshot, tax_status_snapshot, unit_gross_amount, quantity,
         line_net_amount, line_tax_amount, line_gross_amount
       )
       VALUES (
         $1, 'Listed product', 'physical', 'PLN', 'exempt', 'exempt', 100, 1,
         100, 0, 100
       )`,
      [id],
    )
  }

  return { id, orderNumber, email, sellerNip }
}

async function list(authorization, query) {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value))
  }

  const headers = {}

  if (authorization) {
    headers.Authorization = authorization
  }

  const response = await fetch(
    `${baseUrl}/api/v1/admin/orders?${params.toString()}`,
    { headers },
  )
  return { status: response.status, payload: await response.json() }
}
