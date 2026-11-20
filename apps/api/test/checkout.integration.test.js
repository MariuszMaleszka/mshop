import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { writeRegistrationToken } from '../src/checkout/online-payment.js'
import { placeCheckoutOrder } from '../src/checkout/repository.js'
import { registerCheckoutRoutes } from '../src/checkout/routes.js'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { loadConfig } from '../src/config.js'
import { HttpError } from '../src/http/errors.js'
import { createP24Client } from '../src/p24/client.js'
import {
  P24HttpError,
  P24NetworkError,
  P24TimeoutError,
} from '../src/p24/errors.js'
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
let onlineServer
let onlineBaseUrl
let productionServer
let productionBaseUrl
let placeTransaction
let clientFactory = () => {
  throw new Error('P24 client was not prepared')
}
const productionCalls = []
const sandboxP24 = {
  environment: 'sandbox',
  merchantId: '10001',
  posId: '10002',
  crcKey: 'sandbox-crc-key',
  secretId: 'sandbox-api-secret',
  apiBaseUrl: 'https://sandbox.przelewy24.pl/api/v1',
  requestTimeoutMs: 10000,
  urlReturn: 'https://shop.example/return',
  urlStatus: 'https://shop.example/status',
}
const productionP24 = {
  ...sandboxP24,
  environment: 'production',
  apiBaseUrl: 'https://secure.przelewy24.pl/api/v1',
  urlReturn: 'https://shop.example/return',
  urlStatus: 'https://shop.example/status',
}

const app = database
  ? createApp(config, {
      database,
      accessTokens: appAccessTokens(),
      registerRoutes(router) {
        registerCheckoutRoutes(router, { database })
      },
    })
  : null
const onlineApp = database
  ? createApp(config, {
      database,
      accessTokens: appAccessTokens(),
      registerRoutes(router) {
        registerCheckoutRoutes(router, {
          database,
          p24: sandboxP24,
          createP24Client(received) {
            return clientFactory(received)
          },
        })
      },
    })
  : null
const productionApp = database
  ? createApp(config, {
      database,
      accessTokens: appAccessTokens(),
      registerRoutes(router) {
        registerCheckoutRoutes(router, {
          database,
          p24: productionP24,
          createP24Client() {
            productionCalls.push('create')
            throw new Error('production checkout must not create a P24 client')
          },
        })
      },
    })
  : null

function appAccessTokens() {
  return {
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
  }
}

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
    const online = await listen(onlineApp)
    onlineServer = online.server
    onlineBaseUrl = online.baseUrl
    const production = await listen(productionApp)
    productionServer = production.server
    productionBaseUrl = production.baseUrl
  })

  after(async () => {
    try {
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
      onlineServer?.close()
      productionServer?.close()
      await database.close()
    } finally {
      await releaseIntegration?.()
    }
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
    assert.equal(stored.user_id, null)
    assert.equal(stored.order_session_id, session.hash)
    assert.notEqual(stored.order_session_id, session.raw)
    assert.equal(stored.session_id, session.hash)
    assert.equal(JSON.stringify(first.payload).includes(session.raw), false)
    assert.equal(first.payload.data.session_id, undefined)
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
      assert.equal(await ordersForSession(session.hash), 0)
      assert.equal(await rawSessionStored(session.raw), 0)
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
    const heldOrder = await orderRow(held.payload.data.id)
    const exactOrder = await orderRow(exact.payload.data.id)
    assert.equal(heldOrder.order_session_id, first.hash)
    assert.equal(exactOrder.order_session_id, second.hash)
    assert.notEqual(heldOrder.order_session_id, second.hash)
    assert.notEqual(exactOrder.order_session_id, first.hash)
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
    assert.equal(stored.order_session_id, null)
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

  it('rejects a combined owner and keeps an order without one', async () => {
    await setSeller('exempt')
    const session = await guestCart({
      taxStatus: 'exempt',
      vatRate: null,
      stock: 2,
    })
    const created = await checkout(session)
    const orderId = created.payload.data.id
    const userId = randomUUID()
    userIds.push(userId)
    await database.query('INSERT INTO auth.users (id) VALUES ($1)', [userId])

    await assert.rejects(
      () =>
        database.query('UPDATE public.orders SET user_id = $2 WHERE id = $1', [
          orderId,
          userId,
        ]),
      (error) => error.code === '23514',
    )
    await assert.rejects(
      () =>
        database.query(
          'UPDATE public.orders SET session_id = $2 WHERE id = $1',
          [orderId, 'not-a-session-hash'],
        ),
      (error) => error.code === '23514',
    )

    await assert.rejects(
      () =>
        database.withTransaction(async (tx) => {
          await tx.query(
            'UPDATE public.orders SET user_id = NULL, session_id = NULL WHERE id = $1',
            [orderId],
          )
          const cleared = await tx.query(
            'SELECT user_id, session_id FROM public.orders WHERE id = $1',
            [orderId],
          )
          assert.equal(cleared.rows[0].user_id, null)
          assert.equal(cleared.rows[0].session_id, null)
          throw new Error('rollback cleared owner')
        }),
      (error) => error.message === 'rollback cleared owner',
    )

    const stored = await orderRow(orderId)
    assert.equal(stored.user_id, null)
    assert.equal(stored.order_session_id, session.hash)
    assert.equal(await rawSessionStored(session.raw), 0)
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
      body: checkoutBody(`a${session.hash.slice(0, 8)}@checkout.test`, {
        paymentMethod: 'online',
      }),
    })

    assert.equal(unknown.status, 409)
    assert.equal(unknown.payload.error.code, 'SELLER_TAX_STATUS_UNKNOWN')
    assert.equal(online.status, 503)
    assert.equal(online.payload.error.code, 'SERVICE_UNAVAILABLE')
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

    assert.equal(created.status, 201)

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

  it('creates an online order atomically and stores the redirect token', async () => {
    const calls = []
    useFetch(async (url, options) => {
      calls.push({
        url: String(url),
        method: options.method,
        body: options.body,
      })
      assert.equal(
        String(url).startsWith('https://sandbox.przelewy24.pl/'),
        true,
      )
      return jsonResult(
        200,
        '{"responseCode":0,"data":{"token":"tok_sandbox"}}',
      )
    })
    const session = await onlineCart()
    const result = await onlineCheckout(session)
    const row = await onlineRow(result.payload.data.id)
    const text = JSON.stringify(result.payload)

    assert.equal(result.status, 201)
    assert.equal(result.payload.data.paymentMethod, 'online')
    assert.equal(result.payload.data.paymentStatus, 'pending')
    assert.equal(result.payload.data.payment.initializationStatus, 'registered')
    assert.equal(
      result.payload.data.payment.redirectUrl,
      'https://sandbox.przelewy24.pl/trnRequest/tok_sandbox',
    )
    assert.equal(row.initialization_status, 'registered')
    assert.equal(row.redirect_token, 'tok_sandbox')
    assert.equal(row.provider_transaction_id, null)
    assert.equal(row.reservation_method, 'online')
    assert.equal(row.reservation_status, 'active')
    assert.equal(row.reservation_window, true)
    assert.equal(row.stock_quantity, 3)
    assert.equal(row.cart_status, 'converted')
    assert.equal(row.order_session_id, session.hash)
    assert.notEqual(row.order_session_id, session.raw)
    assert.equal(text.includes(session.raw), false)
    assert.equal(row.response_status, 201)
    assert.equal(
      row.response_body.data.payment.initializationStatus,
      'not_started',
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].body.includes(row.payment_id), true)
    assert.equal(calls[0].body.includes('sandbox-crc-key'), false)
    assert.equal(calls[0].body.includes('sandbox-api-secret'), false)
    assert.equal(
      text.includes('https://sandbox.przelewy24.pl/trnRequest/tok_sandbox'),
      true,
    )
    assert.equal(text.includes('secure.przelewy24.pl'), false)
    assert.equal(text.includes('sandbox-crc-key'), false)
  })

  it('leaves initialization unknown after an ambiguous registration result', async () => {
    const cases = [
      [
        'timeout',
        () => {
          throw new P24TimeoutError()
        },
      ],
      [
        'http',
        () => {
          throw new P24HttpError(400)
        },
      ],
      [
        'network',
        () => {
          throw new P24NetworkError()
        },
      ],
      ['json', () => useBrokenFetch('not-json')],
      ['incomplete', () => useBrokenFetch('{"responseCode":0}')],
    ]

    for (const [name, prepare] of cases) {
      const calls = { register: 0 }
      if (name === 'json' || name === 'incomplete') {
        prepare()
      } else {
        clientFactory = () => ({
          async registerTransaction() {
            calls.register += 1
            prepare()
          },
          async getTransactionBySessionId() {
            throw new Error(`${name} lookup`)
          },
        })
      }
      const session = await onlineCart()
      const result = await onlineCheckout(session)
      const row = await onlineRow(result.payload.data.id)

      assert.equal(result.status, 201, name)
      assert.equal(result.payload.data.id, row.order_id)
      assert.equal(result.payload.data.payment.initializationStatus, 'unknown')
      assert.equal(result.payload.data.payment.redirectUrl, undefined)
      assert.equal(row.initialization_status, 'unknown')
      assert.equal(row.redirect_token, null)
      assert.equal(row.status, 'pending')
      assert.equal(row.payment_status, 'pending')
    }
  })

  it('reads an unknown payment by session id and does not register again', async () => {
    const calls = { register: 0, lookup: 0 }
    let lookupError = null
    clientFactory = () => ({
      async registerTransaction() {
        calls.register += 1
        throw new P24TimeoutError()
      },
      async getTransactionBySessionId(sessionId) {
        calls.lookup += 1
        if (lookupError) {
          throw lookupError
        }
        return { sessionId, orderId: '15', status: '0' }
      },
    })
    const session = await onlineCart()
    const created = await onlineCheckout(session)

    for (const status of ['0', '1', '2', '3']) {
      calls.lookup = 0
      clientFactory = () => ({
        async registerTransaction() {
          calls.register += 1
          throw new Error('register')
        },
        async getTransactionBySessionId(sessionId) {
          calls.lookup += 1
          return { sessionId, orderId: '15', status }
        },
      })
      const repeated = await onlineCheckout(session)
      const row = await onlineRow(created.payload.data.id)

      assert.equal(repeated.status, 201)
      assert.equal(
        repeated.payload.data.payment.initializationStatus,
        'unknown',
      )
      assert.equal(row.status, 'pending')
      assert.equal(row.payment_status, 'pending')
      assert.equal(row.redirect_token, null)
      assert.equal(calls.lookup, 1)
      assert.equal(calls.register, 1)
    }

    lookupError = new P24HttpError(404)
    clientFactory = () => ({
      async registerTransaction() {
        calls.register += 1
        throw new Error('register')
      },
      async getTransactionBySessionId() {
        calls.lookup += 1
        throw lookupError
      },
    })
    const missing = await onlineCheckout(session)
    const afterMissing = await onlineRow(created.payload.data.id)

    assert.equal(missing.status, 201)
    assert.equal(afterMissing.initialization_status, 'unknown')
    assert.equal(calls.register, 1)
  })

  it('starts the first registration when a committed payment is still not_started', async () => {
    const session = await onlineCart()
    const body = checkoutBody(session.email, { paymentMethod: 'online' })
    const created = await database.withTransaction((tx) =>
      placeCheckoutOrder(tx, {
        owner: { kind: 'guest', key: session.hash },
        idempotencyKey: session.key,
        body,
        onlineReady: true,
      }),
    )
    const before = await onlineRow(created.online.orderId)
    const calls = { register: 0, lookup: 0 }
    clientFactory = () => ({
      async registerTransaction() {
        calls.register += 1
        return { token: 'tok_resumed' }
      },
      async getTransactionBySessionId() {
        calls.lookup += 1
        return { sessionId: before.payment_id, orderId: '15', status: '0' }
      },
    })
    const resumed = await onlineCheckout(session, { body })
    const after = await onlineRow(created.online.orderId)

    assert.equal(before.initialization_status, 'not_started')
    assert.equal(before.redirect_token, null)
    assert.equal(resumed.status, 201)
    assert.equal(after.initialization_status, 'registered')
    assert.equal(after.redirect_token, 'tok_resumed')
    assert.equal(calls.register, 1)
    assert.equal(calls.lookup, 0)
  })

  it('does not keep a token when the payment changed during registration', async () => {
    const mutations = [
      async (paymentId) => {
        await database.query(
          `
            UPDATE public.payments
            SET status = 'paid', paid_at = clock_timestamp(), provider_transaction_id = $2
            WHERE id = $1
          `,
          [paymentId, `paid-${paymentId}`],
        )
        await database.query(
          `
            UPDATE public.orders
            SET payment_status = 'paid'
            WHERE id = (SELECT order_id FROM public.payments WHERE id = $1)
          `,
          [paymentId],
        )
      },
      async (paymentId) => {
        await database.query(
          `
            UPDATE public.payments
            SET provider_transaction_id = $2
            WHERE id = $1
          `,
          [paymentId, `txn-${paymentId}`],
        )
      },
      async (paymentId) => {
        await database.query(
          `
            UPDATE public.payments
            SET initialization_status = 'rejected'
            WHERE id = $1
          `,
          [paymentId],
        )
      },
      async (paymentId) => {
        await database.query(
          `
            UPDATE public.payments
            SET initialization_status = 'registered', redirect_token = 'kept_token'
            WHERE id = $1
          `,
          [paymentId],
        )
      },
    ]

    for (const mutate of mutations) {
      clientFactory = () => ({
        async registerTransaction(input) {
          await mutate(input.sessionId)
          return { token: 'tok_rejected' }
        },
        async getTransactionBySessionId() {
          throw new Error('lookup')
        },
      })
      const session = await onlineCart()
      const result = await onlineCheckout(session)
      const row = await onlineRow(result.payload.data.id)

      assert.equal(result.status, 201)
      assert.notEqual(row.redirect_token, 'tok_rejected')
      assert.equal(row.payment_status, result.payload.data.paymentStatus)
      assert.equal(
        result.payload.data.payment.initializationStatus,
        row.initialization_status,
      )
    }
  })

  it('does not save a token when amount, currency, or order do not match', async () => {
    clientFactory = () => ({
      async registerTransaction() {
        throw new P24TimeoutError()
      },
      async getTransactionBySessionId() {
        throw new Error('lookup')
      },
    })
    const session = await onlineCart()
    const created = await onlineCheckout(session)
    const row = await onlineRow(created.payload.data.id)
    const mismatches = [
      { ...row, amount: '101' },
      { ...row, payment_currency: 'EUR' },
      { ...row, order_id: '00000000-0000-4000-8000-000000000099' },
    ]

    for (const candidate of mismatches) {
      const updated = await database.withTransaction((tx) =>
        writeRegistrationToken(tx, candidate, 'tok_amount'),
      )
      const current = await onlineRow(created.payload.data.id)

      assert.equal(updated, 0)
      assert.equal(current.initialization_status, 'unknown')
      assert.equal(current.redirect_token, null)
      assert.equal(current.amount, '100')
    }
  })

  it('leaves unknown when lookup data does not belong to the payment', async () => {
    const modes = [
      'foreign-session',
      'bad-order',
      'incomplete',
      'invalid-json',
      'network',
    ]

    for (const mode of modes) {
      let stage = 'register'
      useFetch(async (url, options) => {
        if (stage === 'register') {
          if (options.method !== 'POST') {
            throw new TypeError('lookup during registration')
          }
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }

        if (mode === 'network') {
          throw new TypeError('socket closed')
        }
        if (mode === 'invalid-json') {
          return jsonResult(200, 'not-json')
        }
        if (mode === 'incomplete') {
          return jsonResult(200, '{"responseCode":0}')
        }
        if (mode === 'bad-order') {
          const sessionId = decodeURIComponent(String(url).split('/').at(-1))
          return jsonResult(
            200,
            `{"responseCode":0,"data":{"orderId":-1,"sessionId":${JSON.stringify(sessionId)},"status":0,"amount":1,"currency":"PLN"}}`,
          )
        }

        return jsonResult(
          200,
          '{"responseCode":0,"data":{"orderId":15,"sessionId":"other-session","status":2,"amount":1,"currency":"PLN"}}',
        )
      })
      const session = await onlineCart()
      const created = await onlineCheckout(session)
      stage = 'lookup'
      const repeated = await onlineCheckout(session)
      const row = await onlineRow(created.payload.data.id)

      assert.equal(created.status, 201, mode)
      assert.equal(repeated.status, 201, mode)
      assert.equal(row.initialization_status, 'unknown', mode)
      assert.equal(row.redirect_token, null, mode)
      assert.equal(row.status, 'pending', mode)
      assert.equal(row.payment_status, 'pending', mode)
    }
  })

  it('serializes parallel checkout of the same idempotency key', async () => {
    let entered = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    clientFactory = () => ({
      async registerTransaction() {
        entered += 1
        if (entered === 1) {
          await gate
        }
        return { token: 'tok_parallel' }
      },
      async getTransactionBySessionId() {
        throw new Error('lookup')
      },
    })
    const session = await onlineCart()
    const pending = Promise.all([
      onlineCheckout(session),
      onlineCheckout(session),
    ])
    const started = Date.now()

    while (entered < 1 && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(entered, 1)
    release()
    const results = await pending
    const ids = results.map((result) => result.payload.data.id)

    assert.equal(results[0].status, 201)
    assert.equal(results[1].status, 201)
    assert.equal(ids[0], ids[1])
    assert.equal(entered, 1)
    assert.equal((await onlineRow(ids[0])).redirect_token, 'tok_parallel')
    assert.equal(await countOrders(session.email), 1)
  })

  it('keeps a committed order when the payment read fails and recovers it on retry', async () => {
    clientFactory = () => ({
      async registerTransaction() {
        return { token: 'tok_recovered' }
      },
      async getTransactionBySessionId() {
        throw new Error('lookup')
      },
    })
    const session = await onlineCart()
    const original = database.withSessionLock.bind(database)
    database.withSessionLock = async () => {
      throw new Error('payment read failed')
    }

    try {
      const failed = await onlineCheckout(session)
      const stored = await database.query(
        `
          SELECT id
          FROM public.orders
          WHERE customer_email = $1
        `,
        [session.email],
      )

      assert.equal(failed.status, 503)
      assert.equal(failed.payload.error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(failed.payload.error.message, 'Service unavailable')
      assert.equal(stored.rows.length, 1)
    } finally {
      database.withSessionLock = original
    }

    const recovered = await onlineCheckout(session)
    const row = await onlineRow(recovered.payload.data.id)

    assert.equal(recovered.status, 201)
    assert.equal(row.initialization_status, 'registered')
    assert.equal(row.redirect_token, 'tok_recovered')
  })

  it('rolls back an online order and restores an expired idempotency key', async () => {
    clientFactory = () => ({
      async registerTransaction() {
        return { token: 'tok_first' }
      },
      async getTransactionBySessionId() {
        throw new Error('lookup')
      },
    })
    const session = await onlineCart()
    const created = await onlineCheckout(session)

    assert.equal(created.status, 201)

    const previous = await expireIdempotency(session)
    await openActiveCart(session)
    const before = await countOrders(session.email)
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
      const failed = await onlineCheckout(session)
      const keys = await idempotencyRows(session)

      assert.equal(failed.status, 503)
      assert.equal(keys.length, 1)
      assert.equal(keys[0].id, previous.id)
      assert.equal(keys[0].current, false)
      assert.equal(await countOrders(session.email), before)
    } finally {
      database.withTransaction = placeTransaction
    }
  })

  it('does not create an online order when production checkout is disabled', async () => {
    const session = await onlineCart()
    const before = await countOrders(session.email)
    const response = await fetch(`${productionBaseUrl}/api/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': session.key,
        cookie: `shop_guest_session=${session.raw}`,
      },
      body: JSON.stringify(
        checkoutBody(session.email, { paymentMethod: 'online' }),
      ),
    })
    const payload = await response.json()

    assert.equal(response.status, 503)
    assert.equal(payload.error.code, 'SERVICE_UNAVAILABLE')
    assert.equal(productionCalls.length, 0)
    assert.equal(await countOrders(session.email), before)
    assert.equal(await cartStatus(session.hash), 'active')
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
        btrim(o.session_id) AS order_session_id,
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

async function ordersForSession(sessionHash) {
  const result = await database.query(
    'SELECT count(*)::int AS total FROM public.orders WHERE session_id = $1',
    [sessionHash],
  )
  return result.rows[0].total
}

async function rawSessionStored(rawSessionId) {
  const result = await database.query(
    `
      SELECT count(*)::int AS total
      FROM public.orders
      WHERE session_id::text = $1
         OR customer_email = $1
         OR billing_snapshot::text LIKE '%' || $1 || '%'
    `,
    [rawSessionId],
  )
  return result.rows[0].total
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

function useFetch(fetchImpl) {
  clientFactory = () => createP24Client(sandboxP24, { fetch: fetchImpl })
}

function useBrokenFetch(body) {
  useFetch(async (_url, options) => {
    assert.equal(options.method, 'POST')
    return jsonResult(200, body)
  })
}

function jsonResult(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body
    },
  }
}

async function onlineCart() {
  await setSeller('exempt')
  const session = await guestCart({
    taxStatus: 'exempt',
    vatRate: null,
    stock: 3,
  })
  session.email = `b${session.hash.slice(0, 12)}@checkout.test`
  return session
}

async function onlineCheckout(session, { key = session.key, body } = {}) {
  const response = await fetch(`${onlineBaseUrl}/api/v1/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      cookie: `shop_guest_session=${session.raw}`,
    },
    body: JSON.stringify(
      body ?? checkoutBody(session.email, { paymentMethod: 'online' }),
    ),
  })

  return { status: response.status, payload: await response.json() }
}

async function onlineRow(orderId) {
  const result = await database.query(
    `
      SELECT
        o.id AS order_id,
        btrim(o.session_id) AS order_session_id,
        o.payment_status,
        o.gross_amount::text AS gross_amount,
        p.id AS payment_id,
        p.status,
        p.initialization_status,
        p.redirect_token,
        p.provider_transaction_id,
        p.amount::text AS amount,
        btrim(p.currency) AS payment_currency,
        r.payment_method AS reservation_method,
        r.status AS reservation_status,
        (
          r.expires_at > clock_timestamp() + interval '14 minutes'
          AND r.expires_at <= clock_timestamp() + interval '16 minutes'
        ) AS reservation_window,
        pr.stock_quantity,
        ik.response_status,
        ik.response_body,
        c.status AS cart_status
      FROM public.orders AS o
      JOIN public.payments AS p ON p.order_id = o.id
      JOIN public.inventory_reservations AS r ON r.order_id = o.id
      JOIN public.products AS pr ON pr.id = r.product_id
      JOIN public.idempotency_keys AS ik ON ik.order_id = o.id
      JOIN public.carts AS c
        ON c.session_id = ik.session_id
       AND c.status = 'converted'
      WHERE o.id = $1
    `,
    [orderId],
  )

  assert.equal(result.rows.length, 1)
  return result.rows[0]
}

async function cartStatus(hash) {
  const result = await database.query(
    'SELECT status FROM public.carts WHERE session_id = $1',
    [hash],
  )
  return result.rows[0]?.status ?? null
}
