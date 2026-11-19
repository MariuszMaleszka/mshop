import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { registerCheckoutRoutes } from '../src/checkout/routes.js'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { loadConfig } from '../src/config.js'
import { HttpError } from '../src/http/errors.js'
import { hashGuestSessionId } from '../src/session/guest-session.js'

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
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    })
  : null
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const tokens = new Map()
const productIds = []
const sessionHashes = []
const userIds = []
let originalSeller = null
let server
let baseUrl
let placeTransaction

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
        registerCheckoutRoutes(router, { database })
      },
    })
  : null

function listen(target) {
  return new Promise((resolve) => {
    const listening = target.listen(0, '127.0.0.1', () => {
      const address = listening.address()
      resolve({
        server: listening,
        baseUrl: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

describe('cash checkout', { concurrency: 1, skip }, () => {
  before(async () => {
    if (!database) {
      return
    }

    const seller = await database.query(
      `
        SELECT seller_tax_status, business_name, nip, street, building_number,
          unit_number, postal_code, city, country_code
        FROM public.shop_profile
        WHERE id = true
      `,
    )
    originalSeller = seller.rows[0]
    placeTransaction = database.withTransaction.bind(database)
    const listened = await listen(app)
    server = listened.server
    baseUrl = listened.baseUrl
  })

  after(async () => {
    if (!database) {
      return
    }

    await database.query(
      `
        DELETE FROM public.inventory_reservations
        WHERE order_id IN (
          SELECT id FROM public.orders WHERE customer_email LIKE '%@checkout.test'
        )
      `,
    )
    await database.query(
      `
        DELETE FROM public.payments
        WHERE order_id IN (
          SELECT id FROM public.orders WHERE customer_email LIKE '%@checkout.test'
        )
      `,
    )
    if (sessionHashes.length > 0) {
      await database.query(
        'DELETE FROM public.idempotency_keys WHERE session_id = ANY($1::char(64)[])',
        [sessionHashes],
      )
    }
    if (userIds.length > 0) {
      await database.query(
        'DELETE FROM public.idempotency_keys WHERE user_id = ANY($1::uuid[])',
        [userIds],
      )
    }
    await database.query(
      `DELETE FROM public.orders WHERE customer_email LIKE '%@checkout.test'`,
    )
    await database.query(
      `DELETE FROM public.customers WHERE email LIKE '%@checkout.test'`,
    )
    if (sessionHashes.length > 0) {
      await database.query(
        `
          DELETE FROM public.cart_items
          WHERE cart_id IN (
            SELECT id FROM public.carts WHERE session_id = ANY($1::char(64)[])
          )
        `,
        [sessionHashes],
      )
      await database.query(
        'DELETE FROM public.carts WHERE session_id = ANY($1::char(64)[])',
        [sessionHashes],
      )
    }
    if (userIds.length > 0) {
      await database.query(
        `
          DELETE FROM public.cart_items
          WHERE cart_id IN (
            SELECT id FROM public.carts WHERE user_id = ANY($1::uuid[])
          )
        `,
        [userIds],
      )
      await database.query(
        'DELETE FROM public.carts WHERE user_id = ANY($1::uuid[])',
        [userIds],
      )
      await database.query(
        'DELETE FROM public.profiles WHERE id = ANY($1::uuid[])',
        [userIds],
      )
      await database.query(
        'DELETE FROM auth.users WHERE id = ANY($1::uuid[])',
        [userIds],
      )
    }
    if (productIds.length > 0) {
      await database.query(
        'DELETE FROM public.products WHERE id = ANY($1::uuid[])',
        [productIds],
      )
    }
    if (originalSeller) {
      await restoreSeller(originalSeller)
    }
    server?.close()
    await database.close()
  })

  it('creates a cash order for an exempt seller and replays the same key', async () => {
    const session = await guestCart({
      taxStatus: 'standard',
      vatRate: '23.00',
      stock: 4,
    })
    await setSeller('exempt')
    const first = await checkout(session)
    const repeat = await checkout(session)
    const stored = await orderRow(first.payload.data.id)

    assert.equal(first.status, 201)
    assert.equal(repeat.status, 201)
    assert.equal(repeat.payload.data.id, first.payload.data.id)
    assert.equal(stored.payment_method, 'cash')
    assert.equal(stored.payment_status, 'pending')
    assert.equal(stored.gross_amount, stored.net_amount)
    assert.equal(stored.tax_amount, '0')
    assert.equal(stored.catalog_tax_status_snapshot, 'standard')
    assert.equal(stored.catalog_vat_rate_snapshot, '23.00')
    assert.equal(stored.tax_status_snapshot, 'exempt')
    assert.equal(stored.vat_rate_snapshot, null)
    assert.equal(stored.line_gross_amount, stored.line_net_amount)
    assert.equal(stored.line_tax_amount, '0')
    assert.equal(stored.stock_quantity, 4)
    assert.equal(stored.reservation_status, 'active')
    assert.equal(stored.reservation_method, 'cash')
    assert.equal(stored.expires_at, null)
    assert.equal(stored.cart_status, 'converted')
    assert.equal(stored.customer_user_id, null)
    assert.equal(stored.billing_snapshot.street, 'Lipowa')
    assert.equal(stored.seller_business_name_snapshot, 'Checkout Test')
    assert.equal(stored.provider, null)
    assert.equal(stored.session_id, session.hash)
  })

  it('rejects another body for the same key and another key after conversion', async () => {
    const session = await guestCart({
      taxStatus: 'zero_rated',
      vatRate: '0.00',
      stock: 2,
    })
    await setSeller('registered')
    const created = await checkout(session)
    const reused = await checkout(session, {
      body: checkoutBody(session.email, { email: `other-${session.email}` }),
    })
    const anotherKey = await checkout(session, { key: `other-${session.key}` })
    const count = await countOrders(session.email)

    assert.equal(created.status, 201)
    assert.equal(reused.status, 409)
    assert.equal(reused.payload.error.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(anotherKey.status, 409)
    assert.equal(anotherKey.payload.error.code, 'CART_CONVERTED')
    assert.equal(count, 1)
  })

  it('creates one order when the same key is submitted twice in parallel', async () => {
    const session = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: 3,
    })
    await setSeller('registered')
    const [first, second] = await Promise.all([
      checkout(session),
      checkout(session),
    ])
    const ids = new Set(
      [first, second]
        .filter((result) => result.status === 201)
        .map((result) => result.payload.data.id),
    )

    assert.equal(ids.size, 1)
    assert.equal(await countOrders(session.email), 1)
  })

  it('rolls back every write when a later insert fails', async () => {
    const session = await guestCart({
      taxStatus: 'not_subject',
      vatRate: null,
      stock: 3,
    })
    await setSeller('registered')
    const before = await counts()
    database.withTransaction = async (work) =>
      placeTransaction(async (tx) =>
        work({
          query(text, params) {
            if (text.includes('INSERT INTO public.inventory_reservations')) {
              throw new Error('injected fault')
            }

            return tx.query(text, params)
          },
        }),
      )

    try {
      const result = await checkout(session)
      const afterCounts = await counts()

      assert.equal(result.status, 503)
      assert.equal(result.payload.error.code, 'SERVICE_UNAVAILABLE')
      assert.deepEqual(afterCounts, before)
      assert.equal(await cartStatus(session.hash), 'active')
    } finally {
      database.withTransaction = placeTransaction
    }
  })

  it('blocks unknown stock, zero stock, and a registered standard rate without writes', async () => {
    await setSeller('registered')
    const unknown = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: null,
    })
    const zero = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: 0,
    })
    const standard = await guestCart({
      taxStatus: 'standard',
      vatRate: '23.00',
      stock: 2,
    })
    const before = await counts()
    const unknownResult = await checkout(unknown)
    const zeroResult = await checkout(zero)
    const standardResult = await checkout(standard)

    assert.equal(unknownResult.payload.error.code, 'STOCK_UNKNOWN')
    assert.equal(zeroResult.payload.error.code, 'INSUFFICIENT_STOCK')
    assert.equal(standardResult.payload.error.code, 'VAT_POLICY_NOT_CONFIRMED')
    assert.deepEqual(await counts(), before)
  })

  it('lets the exact remaining quantity through and keeps the loser out', async () => {
    await setSeller('exempt')
    const productId = await insertProduct({
      taxStatus: 'zero_rated',
      vatRate: '0.00',
      stock: 1,
    })
    const first = await guestCart({ productId })
    const second = await guestCart({ productId })
    const [winner, loser] = await Promise.all([
      checkout(first),
      checkout(second),
    ])
    const statuses = [winner.status, loser.status].sort()
    const stored = await database.query(
      'SELECT stock_quantity FROM public.products WHERE id = $1',
      [productId],
    )
    const reserved = await database.query(
      `
        SELECT COALESCE(sum(quantity), 0)::int AS quantity
        FROM public.inventory_reservations
        WHERE product_id = $1 AND status = 'active'
      `,
      [productId],
    )

    assert.deepEqual(statuses, [201, 409])
    assert.equal(
      [winner, loser].find((result) => result.status === 409).payload.error
        .code,
      'INSUFFICIENT_STOCK',
    )
    assert.equal(stored.rows[0].stock_quantity, 1)
    assert.equal(reserved.rows[0].quantity, 1)
  })

  it('counts active reservations from other orders', async () => {
    await setSeller('exempt')
    const productId = await insertProduct({
      taxStatus: 'not_subject',
      vatRate: null,
      stock: 2,
    })
    const first = await guestCart({ productId, quantity: 1 })
    const second = await guestCart({ productId, quantity: 1 })
    const third = await guestCart({ productId, quantity: 1 })
    const held = await checkout(first)
    const exact = await checkout(second)
    const short = await checkout(third)

    assert.equal(held.status, 201)
    assert.equal(exact.status, 201)
    assert.equal(short.status, 409)
    assert.equal(short.payload.error.code, 'INSUFFICIENT_STOCK')
  })

  it('accepts registered zero-tax products and keeps an account customer unchanged', async () => {
    await setSeller('registered')
    const userId = randomUUID()
    const token = randomUUID()
    tokens.set(token, userId)
    userIds.push(userId)
    await database.query('INSERT INTO auth.users (id) VALUES ($1)', [userId])
    await database.query(
      `
        INSERT INTO public.customers (user_id, customer_type, email, first_name, last_name)
        VALUES ($1, 'individual', $2, 'Old', 'Name')
      `,
      [userId, `stored-${userId}@checkout.test`],
    )
    const session = await accountCart(userId, {
      taxStatus: 'zero_rated',
      vatRate: '0.00',
      stock: 2,
    })
    const result = await checkout(session, {
      authorization: `Bearer ${token}`,
      cookie: undefined,
    })
    const stored = await orderRow(result.payload.data.id)

    assert.equal(result.status, 201)
    assert.equal(stored.tax_status_snapshot, 'zero_rated')
    assert.equal(stored.user_id, userId)
    assert.equal(stored.customer_user_id, userId)
    assert.equal(stored.customer_email, session.email)
    assert.equal(
      stored.customer_profile_email,
      `stored-${userId}@checkout.test`,
    )
    assert.equal(
      BigInt(stored.gross_amount),
      BigInt(stored.net_amount) + BigInt(stored.tax_amount),
    )
  })

  it('does not create data for online payment or an unknown seller', async () => {
    const session = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: 2,
    })
    await setSeller('unknown')
    const before = await counts()
    const unknown = await checkout(session)
    await setSeller('exempt')
    const online = await checkout(session, {
      body: checkoutBody(session.email, { paymentMethod: 'online' }),
    })

    assert.equal(unknown.status, 409)
    assert.equal(unknown.payload.error.code, 'SELLER_TAX_STATUS_UNKNOWN')
    assert.equal(online.status, 501)
    assert.equal(online.payload.error.code, 'ONLINE_PAYMENT_NOT_IMPLEMENTED')
    assert.deepEqual(await counts(), before)
    assert.equal(await cartStatus(session.hash), 'active')
  })

  it('replaces an expired key when the guest has a new active cart', async () => {
    await setSeller('exempt')
    const session = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: 3,
    })
    const created = await checkout(session)
    const previous = await expireIdempotency(session)
    await openActiveCart(session)
    const repeated = await checkout(session)
    const keys = await idempotencyRows(session)

    assert.equal(created.status, 201)
    assert.equal(repeated.status, 201)
    assert.notEqual(repeated.payload.data.id, created.payload.data.id)
    assert.equal(await countOrders(session.email), 2)
    assert.equal(keys.length, 1)
    assert.notEqual(keys[0].id, previous.id)
    assert.equal(keys[0].current, true)
    assert.equal(await countPayments(session.email), 2)
    assert.equal(await countReservations(session.email), 2)
  })

  it('keeps an expired key when the cart is already converted', async () => {
    await setSeller('exempt')
    const session = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: 2,
    })
    const created = await checkout(session)
    const previous = await expireIdempotency(session)
    const before = await counts()
    const repeated = await checkout(session)
    const keys = await idempotencyRows(session)

    assert.equal(created.status, 201)
    assert.equal(repeated.status, 409)
    assert.equal(repeated.payload.error.code, 'CART_CONVERTED')
    assert.equal(keys.length, 1)
    assert.equal(keys[0].id, previous.id)
    assert.equal(keys[0].current, false)
    assert.equal(await countOrders(session.email), 1)
    assert.deepEqual(await counts(), before)
  })

  it('restores an expired key when order creation rolls back', async () => {
    await setSeller('exempt')
    const session = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: 3,
    })
    const created = await checkout(session)
    const previous = await expireIdempotency(session)
    await openActiveCart(session)
    const before = await counts()
    database.withTransaction = async (work) =>
      placeTransaction(async (tx) =>
        work({
          query(text, params) {
            if (text.includes('INSERT INTO public.inventory_reservations')) {
              throw new Error('injected fault')
            }

            return tx.query(text, params)
          },
        }),
      )

    try {
      const repeated = await checkout(session)
      const keys = await idempotencyRows(session)

      assert.equal(repeated.status, 503)
      assert.equal(repeated.payload.error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(keys.length, 1)
      assert.equal(keys[0].id, previous.id)
      assert.equal(keys[0].current, false)
      assert.equal(await countOrders(session.email), 1)
      assert.deepEqual(await counts(), before)
    } finally {
      database.withTransaction = placeTransaction
    }
  })

  it('lets one of two parallel reuses of an expired key create the next order', async () => {
    await setSeller('exempt')
    const session = await guestCart({
      taxStatus: 'zero_rated',
      vatRate: '0.00',
      stock: 4,
    })
    const created = await checkout(session)
    const previous = await expireIdempotency(session)
    await openActiveCart(session, { stock: 4 })
    const [first, second] = await Promise.all([
      checkout(session),
      checkout(session),
    ])
    const createdIds = [first, second]
      .filter((result) => result.status === 201)
      .map((result) => result.payload.data.id)
    const keys = await idempotencyRows(session)
    const allowedError = new Set([
      'CART_CONVERTED',
      'IDEMPOTENCY_KEY_REUSED',
      'SERVICE_UNAVAILABLE',
    ])

    assert.equal(created.status, 201)
    assert.equal(new Set(createdIds).size, 1)
    assert.notEqual(createdIds[0], created.payload.data.id)
    assert.equal(await countOrders(session.email), 2)
    assert.equal(keys.length, 1)
    assert.notEqual(keys[0].id, previous.id)
    assert.equal(keys[0].current, true)
    for (const result of [first, second]) {
      if (result.status === 201) {
        assert.equal(result.payload.data.id, createdIds[0])
      } else {
        assert.equal(allowedError.has(result.payload.error.code), true)
      }
    }
  })
})

async function guestCart({
  taxStatus = 'exempt',
  vatRate = null,
  stock = 2,
  quantity = 1,
  productId,
} = {}) {
  const raw = randomBytes(32).toString('hex')
  const hash = hashGuestSessionId(raw)
  sessionHashes.push(hash)
  const id = productId ?? (await insertProduct({ taxStatus, vatRate, stock }))
  const email = `buyer-${randomUUID()}@checkout.test`
  const cart = await database.query(
    `
      INSERT INTO public.carts (session_id, currency)
      VALUES ($1, 'PLN')
      RETURNING id
    `,
    [hash],
  )
  await database.query(
    `
      INSERT INTO public.cart_items (cart_id, product_id, quantity)
      VALUES ($1, $2, $3)
    `,
    [cart.rows[0].id, id, quantity],
  )

  return { raw, hash, email, key: `key-${randomUUID()}` }
}

async function accountCart(userId, product) {
  const session = await guestCart(product)
  await database.query('DELETE FROM public.carts WHERE session_id = $1', [
    session.hash,
  ])
  const cart = await database.query(
    `
      INSERT INTO public.carts (user_id, currency)
      VALUES ($1, 'PLN')
      RETURNING id
    `,
    [userId],
  )
  await database.query(
    `
      INSERT INTO public.cart_items (cart_id, product_id, quantity)
      VALUES ($1, $2, 1)
    `,
    [cart.rows[0].id, productIds.at(-1)],
  )
  return { ...session, userId }
}

async function insertProduct({ taxStatus, vatRate, stock }) {
  const result = await database.query(
    `
      INSERT INTO public.products (
        name, slug, description, product_type, sku, price_amount, currency,
        tax_status, vat_rate, is_active, stock_quantity
      )
      VALUES ($1, $2, $3, 'service', $4, 100, 'PLN', $5, $6, true, $7)
      RETURNING id
    `,
    [
      'Checkout product',
      `checkout-${randomUUID()}`,
      'Checkout product',
      `sku-${randomUUID()}`,
      taxStatus,
      vatRate,
      stock,
    ],
  )
  productIds.push(result.rows[0].id)
  return result.rows[0].id
}

async function setSeller(status) {
  const identity =
    status === 'unknown'
      ? [null, null, null, null, null, null]
      : ['Checkout Test', '5555555555', 'Testowa', '1', '00-001', 'Testowo']

  await database.query(
    `
      UPDATE public.shop_profile
      SET seller_tax_status = $1,
        business_name = $2,
        nip = $3,
        street = $4,
        building_number = $5,
        unit_number = NULL,
        postal_code = $6,
        city = $7,
        country_code = 'PL'
      WHERE id = true
    `,
    [status, ...identity],
  )
}

async function restoreSeller(seller) {
  await database.query(
    `
      UPDATE public.shop_profile
      SET seller_tax_status = $1,
        business_name = $2,
        nip = $3,
        street = $4,
        building_number = $5,
        unit_number = $6,
        postal_code = $7,
        city = $8,
        country_code = $9
      WHERE id = true
    `,
    [
      seller.seller_tax_status,
      seller.business_name,
      seller.nip,
      seller.street,
      seller.building_number,
      seller.unit_number,
      seller.postal_code,
      seller.city,
      seller.country_code,
    ],
  )
}

function checkoutBody(email, overrides = {}) {
  return {
    email,
    customerType: 'individual',
    paymentMethod: 'cash',
    billing: {
      firstName: 'Anna',
      lastName: 'Nowak',
      street: 'Lipowa',
      buildingNumber: '1',
      postalCode: '00-001',
      city: 'Warszawa',
      countryCode: 'PL',
    },
    ...overrides,
  }
}

async function checkout(
  session,
  { key = session.key, body, authorization } = {},
) {
  const response = await fetch(`${baseUrl}/api/v1/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...(session.raw ? { cookie: `shop_guest_session=${session.raw}` } : {}),
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body ?? checkoutBody(session.email)),
  })

  return { status: response.status, payload: await response.json() }
}

async function orderRow(orderId) {
  const result = await database.query(
    `
      SELECT
        o.user_id,
        o.customer_email,
        o.payment_method,
        o.payment_status,
        o.gross_amount::text AS gross_amount,
        o.net_amount::text AS net_amount,
        o.tax_amount::text AS tax_amount,
        o.billing_snapshot,
        o.seller_business_name_snapshot,
        oi.catalog_tax_status_snapshot,
        oi.catalog_vat_rate_snapshot::text AS catalog_vat_rate_snapshot,
        oi.tax_status_snapshot,
        oi.vat_rate_snapshot::text AS vat_rate_snapshot,
        oi.line_gross_amount::text AS line_gross_amount,
        oi.line_net_amount::text AS line_net_amount,
        oi.line_tax_amount::text AS line_tax_amount,
        p.stock_quantity,
        r.status AS reservation_status,
        r.payment_method AS reservation_method,
        r.expires_at,
        c.status AS cart_status,
        cu.user_id AS customer_user_id,
        cu.email AS customer_profile_email,
        pay.provider,
        ik.session_id
      FROM public.orders AS o
      JOIN public.order_items AS oi ON oi.order_id = o.id
      JOIN public.products AS p ON p.id = oi.product_id
      JOIN public.inventory_reservations AS r ON r.order_item_id = oi.id
      JOIN public.payments AS pay ON pay.order_id = o.id
      JOIN public.customers AS cu ON cu.id = o.customer_id
      LEFT JOIN public.carts AS c ON c.status = 'converted'
        AND c.session_id = (
          SELECT session_id FROM public.idempotency_keys WHERE order_id = o.id LIMIT 1
        )
      LEFT JOIN public.idempotency_keys AS ik ON ik.order_id = o.id
      WHERE o.id = $1
    `,
    [orderId],
  )

  return result.rows[0]
}

async function countOrders(email) {
  const result = await database.query(
    'SELECT count(*)::int AS total FROM public.orders WHERE customer_email = $1',
    [email],
  )
  return result.rows[0].total
}

async function counts() {
  const result = await database.query(
    `
      SELECT
        (SELECT count(*) FROM public.orders) AS orders,
        (SELECT count(*) FROM public.payments) AS payments,
        (SELECT count(*) FROM public.inventory_reservations) AS reservations,
        (SELECT count(*) FROM public.idempotency_keys) AS idempotency_keys
    `,
  )
  return result.rows[0]
}

async function expireIdempotency(session) {
  const current = await idempotencyRows(session)

  assert.equal(current.length, 1)
  await database.query(
    `
      UPDATE public.idempotency_keys
      SET created_at = clock_timestamp() - interval '2 hours',
        expires_at = clock_timestamp() - interval '1 hour'
      WHERE id = $1
    `,
    [current[0].id],
  )
  const expired = await idempotencyRows(session)

  assert.equal(expired.length, 1)
  assert.equal(expired[0].current, false)
  return expired[0]
}

async function openActiveCart(session, { stock = 2 } = {}) {
  const productId = await insertProduct({
    taxStatus: 'exempt',
    vatRate: null,
    stock,
  })
  const cart = await database.query(
    `
      INSERT INTO public.carts (session_id, currency)
      VALUES ($1, 'PLN')
      RETURNING id
    `,
    [session.hash],
  )
  await database.query(
    `
      INSERT INTO public.cart_items (cart_id, product_id, quantity)
      VALUES ($1, $2, 1)
    `,
    [cart.rows[0].id, productId],
  )
}

async function idempotencyRows(session) {
  const result = await database.query(
    `
      SELECT id, expires_at > clock_timestamp() AS current
      FROM public.idempotency_keys
      WHERE session_id = $1
        AND idempotency_key = $2
        AND operation = 'checkout'
    `,
    [session.hash, session.key],
  )
  return result.rows
}

async function countPayments(email) {
  const result = await database.query(
    `
      SELECT count(*)::int AS total
      FROM public.payments
      WHERE order_id IN (
        SELECT id FROM public.orders WHERE customer_email = $1
      )
    `,
    [email],
  )
  return result.rows[0].total
}

async function countReservations(email) {
  const result = await database.query(
    `
      SELECT count(*)::int AS total
      FROM public.inventory_reservations
      WHERE order_id IN (
        SELECT id FROM public.orders WHERE customer_email = $1
      )
    `,
    [email],
  )
  return result.rows[0].total
}

async function cartStatus(hash) {
  const result = await database.query(
    'SELECT status FROM public.carts WHERE session_id = $1',
    [hash],
  )
  return result.rows[0]?.status ?? null
}
