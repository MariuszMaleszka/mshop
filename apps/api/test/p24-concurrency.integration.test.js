import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import pg from 'pg'
import { createApp } from '../src/app.js'
import { registerCheckoutRoutes } from '../src/checkout/routes.js'
import {
  PAYMENT_ADVISORY_LOCK_NAMESPACE,
  paymentAdvisoryLockKey,
} from '../src/checkout/payment-lock.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, SessionLockTimeoutError } from '../src/db/pool.js'
import { createP24Client } from '../src/p24/client.js'
import {
  P24_WEBHOOK_PATH,
  registerP24WebhookRoutes,
} from '../src/p24/webhook-routes.js'
import { expireOnlineOrder } from '../src/reservation-expiry/expire.js'
import { hashGuestSessionId } from '../src/session/guest-session.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const CRC = 'crc-concurrency-secret'
const TOKEN = 'tok_concurrency'
const SECRETS = [CRC, 'sandbox-crc-key', 'sandbox-api-secret', TOKEN]
const webhookP24 = { merchantId: '10', posId: '11', crcKey: CRC }
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
      max: 6,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    })
  : null
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const logs = []
const logger = {
  info(message, fields) {
    logs.push({ message, fields })
  },
  warn(message, fields) {
    logs.push({ message, fields })
  },
  error(message, fields) {
    logs.push({ message, fields })
  },
}
const productIds = []
const sessionHashes = []
let originalSeller = null
let checkoutServer
let checkoutBaseUrl
let webhookServer
let webhookBaseUrl
let clientFactory = () => {
  throw new Error('P24 client was not prepared')
}
const verifyCalls = []
const hooks = {
  beforeStage: null,
  verify(input) {
    verifyCalls.push(input)
    return { status: 'success' }
  },
}
let nextOrderId = 880000

const checkoutApp = database
  ? createApp(config, {
      database,
      logger,
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
const webhookApp = database
  ? createApp(config, {
      database,
      logger,
      registerRoutes(router) {
        registerP24WebhookRoutes(router, {
          p24: webhookP24,
          database,
          lockTimeoutMs: 200,
          verifyTransaction: (input) => hooks.verify(input),
          beforeFinalizationStage: (stage) => hooks.beforeStage?.(stage),
        })
      },
    })
  : null

function sha384(value) {
  return createHash('sha384').update(value, 'utf8').digest('hex')
}

function signedBody(fields) {
  const sign = sha384(
    `{"merchantId":${webhookP24.merchantId},"posId":${webhookP24.posId},"sessionId":${JSON.stringify(fields.sessionId)},"amount":${fields.amount},"originAmount":${fields.originAmount},"currency":${JSON.stringify(fields.currency)},"orderId":${fields.orderId},"methodId":1,"statement":"","crc":${JSON.stringify(CRC)}}`,
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

function createBarrier() {
  let markEntered
  let release
  const entered = new Promise((resolve) => {
    markEntered = resolve
  })
  const released = new Promise((resolve) => {
    release = resolve
  })
  return { entered, released, markEntered, release }
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value)

  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false)
  }
}

async function listen(target) {
  return new Promise((resolve) => {
    const server = target.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      })
    })
  })
}

async function postWebhook(paymentId, orderId = String(nextOrderId++)) {
  const response = await fetch(`${webhookBaseUrl}${P24_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: signedBody({
      sessionId: paymentId,
      amount: '100',
      originAmount: '100',
      currency: 'PLN',
      orderId,
    }),
  })
  return {
    status: response.status,
    payload: await response.json(),
    orderId,
  }
}

async function setSeller(status) {
  const identity =
    status === 'unknown'
      ? [null, null, null, null, null, null]
      : ['Concurrency Test', '5555555555', 'Testowa', '1', '00-001', 'Testowo']

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

async function guestCart() {
  const raw = randomBytes(32).toString('hex')
  const hash = hashGuestSessionId(raw)
  sessionHashes.push(hash)
  const product = await database.query(
    `
      INSERT INTO public.products (
        name, slug, description, product_type, sku, price_amount, currency,
        tax_status, vat_rate, is_active, stock_quantity
      )
      VALUES (
        'Concurrency product', $1, 'Concurrency product', 'service', $2,
        100, 'PLN', 'exempt', NULL, true, 8
      )
      RETURNING id
    `,
    [`concurrency-${randomUUID()}`, `sku-${randomUUID()}`],
  )
  productIds.push(product.rows[0].id)
  const cart = await database.query(
    `INSERT INTO public.carts (session_id, currency) VALUES ($1, 'PLN') RETURNING id`,
    [hash],
  )
  await database.query(
    `INSERT INTO public.cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 1)`,
    [cart.rows[0].id, product.rows[0].id],
  )
  return {
    raw,
    hash,
    productId: product.rows[0].id,
    email: `b${hash.slice(0, 12)}@concurrency.test`,
    key: `key-${randomUUID()}`,
  }
}

async function paymentByEmail(email) {
  const result = await database.query(
    `
      SELECT
        p.id,
        p.status,
        p.initialization_status,
        p.redirect_token,
        p.provider_transaction_id,
        p.amount::text AS amount,
        btrim(p.currency) AS currency,
        p.provider,
        o.id AS order_id,
        o.payment_status,
        o.fulfillment_status,
        o.gross_amount::text AS gross_amount,
        btrim(o.currency) AS order_currency,
        r.status AS reservation_status,
        pr.stock_quantity
      FROM public.orders AS o
      JOIN public.payments AS p ON p.order_id = o.id
      JOIN public.inventory_reservations AS r ON r.order_id = o.id
      JOIN public.products AS pr ON pr.id = r.product_id
      WHERE o.customer_email = $1
    `,
    [email],
  )
  assert.equal(result.rows.length, 1)
  return result.rows[0]
}

async function events(paymentId) {
  const result = await database.query(
    `
      SELECT event_type
      FROM public.payment_events
      WHERE payment_id = $1
      ORDER BY created_at, id
    `,
    [paymentId],
  )
  return result.rows.map((row) => row.event_type)
}

async function history(orderId) {
  const result = await database.query(
    `
      SELECT status_type, old_status, new_status
      FROM public.order_status_history
      WHERE order_id = $1
      ORDER BY id
    `,
    [orderId],
  )
  return result.rows
}

async function lockCount(paymentId) {
  const key = paymentAdvisoryLockKey(paymentId)
  const unsigned = key < 0 ? key + 4294967296 : key
  const result = await database.query(
    `
      SELECT count(*)::text AS total
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = $1
        AND objid = $2::oid
        AND granted
    `,
    [PAYMENT_ADVISORY_LOCK_NAMESPACE, String(unsigned)],
  )
  return Number(result.rows[0].total)
}

async function waitForPaymentLock(paymentId) {
  const deadline = performance.now() + 5000

  while (performance.now() < deadline) {
    if ((await lockCount(paymentId)) === 1) {
      return
    }

    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }

  throw new Error('payment lock was not acquired')
}

async function createDueOrder() {
  const product = await database.query(
    `
      INSERT INTO public.products (
        name, slug, description, product_type, sku, price_amount, currency,
        tax_status, vat_rate, is_active, stock_quantity
      )
      VALUES (
        'Concurrency product', $1, 'Concurrency product', 'service', $2,
        100, 'PLN', 'exempt', NULL, true, 8
      )
      RETURNING id
    `,
    [`concurrency-${randomUUID()}`, `sku-${randomUUID()}`],
  )
  const productId = product.rows[0].id
  productIds.push(productId)
  const email = `w${randomUUID().slice(0, 8)}@concurrency.test`
  const order = await database.query(
    `
      INSERT INTO public.orders (
        order_number, customer_email, customer_type, billing_snapshot,
        seller_tax_status_snapshot, seller_business_name_snapshot,
        seller_nip_snapshot, seller_street_snapshot, seller_building_number_snapshot,
        seller_postal_code_snapshot, seller_city_snapshot, seller_country_code_snapshot,
        currency, net_amount, tax_amount, gross_amount, payment_method, payment_status,
        fulfillment_status
      )
      VALUES (
        $1, $2, 'individual', '{}'::jsonb, 'exempt', 'Concurrency Seller',
        '5555555555', 'Lipowa', '1', '00-001', 'Warszawa', 'PL',
        'PLN', 100, 0, 100, 'online', 'pending', 'new'
      )
      RETURNING id
    `,
    [`C${randomUUID().replaceAll('-', '')}`, email],
  )
  const orderId = order.rows[0].id
  const item = await database.query(
    `
      INSERT INTO public.order_items (
        order_id, product_id, product_name_snapshot, product_type_snapshot,
        currency, catalog_tax_status_snapshot, tax_status_snapshot,
        unit_gross_amount, quantity, line_net_amount, line_tax_amount, line_gross_amount
      )
      VALUES (
        $1, $2, 'Concurrency product', 'service', 'PLN', 'exempt', 'exempt',
        100, 1, 100, 0, 100
      )
      RETURNING id
    `,
    [orderId, productId],
  )
  await database.query(
    `
      INSERT INTO public.inventory_reservations (
        order_id, order_item_id, product_id, payment_method, quantity, status, expires_at
      )
      VALUES ($1, $2, $3, 'online', 1, 'active', clock_timestamp() - interval '1 minute')
    `,
    [orderId, item.rows[0].id, productId],
  )
  const payment = await database.query(
    `
      INSERT INTO public.payments (
        order_id, method, provider, status, amount, currency, paid_at,
        refunded_amount, initialization_status
      )
      VALUES (
        $1, 'online', 'przelewy24', 'pending', 100, 'PLN', NULL, 0, 'not_started'
      )
      RETURNING id
    `,
    [orderId],
  )
  return { orderId, paymentId: payment.rows[0].id, productId, email }
}

describe('P24 payment lock concurrency', { concurrency: 1, skip }, () => {
  beforeEach(() => {
    verifyCalls.length = 0
    logs.length = 0
    hooks.beforeStage = null
  })

  before(async () => {
    const seller = await database.query(
      `
        SELECT seller_tax_status, business_name, nip, street, building_number,
          unit_number, postal_code, city, country_code
        FROM public.shop_profile
        WHERE id = true
      `,
    )
    originalSeller = seller.rows[0]
    await setSeller('exempt')
    const checkout = await listen(checkoutApp)
    checkoutServer = checkout.server
    checkoutBaseUrl = checkout.baseUrl
    const webhook = await listen(webhookApp)
    webhookServer = webhook.server
    webhookBaseUrl = webhook.baseUrl
  })

  after(async () => {
    try {
      if (checkoutServer) {
        await new Promise((resolve, reject) => {
          checkoutServer.close((error) => (error ? reject(error) : resolve()))
        })
      }

      if (webhookServer) {
        await new Promise((resolve, reject) => {
          webhookServer.close((error) => (error ? reject(error) : resolve()))
        })
      }

      if (!database) {
        return
      }

      await database.query(
        `
          DELETE FROM public.inventory_reservations
          WHERE order_id IN (
            SELECT id FROM public.orders WHERE customer_email LIKE '%@concurrency.test'
          )
        `,
      )
      await database.query(
        `
          DELETE FROM public.payment_events
          WHERE payment_id IN (
            SELECT id FROM public.payments
            WHERE order_id IN (
              SELECT id FROM public.orders WHERE customer_email LIKE '%@concurrency.test'
            )
          )
        `,
      )
      await database.query(
        `
          DELETE FROM public.payments
          WHERE order_id IN (
            SELECT id FROM public.orders WHERE customer_email LIKE '%@concurrency.test'
          )
        `,
      )
      await database.query(
        `
          DELETE FROM public.order_items
          WHERE order_id IN (
            SELECT id FROM public.orders WHERE customer_email LIKE '%@concurrency.test'
          )
        `,
      )
      await database.query(
        `
          DELETE FROM public.order_status_history
          WHERE order_id IN (
            SELECT id FROM public.orders WHERE customer_email LIKE '%@concurrency.test'
          )
        `,
      )
      if (sessionHashes.length > 0) {
        await database.query(
          'DELETE FROM public.idempotency_keys WHERE session_id = ANY($1::char(64)[])',
          [sessionHashes],
        )
      }
      await database.query(
        `DELETE FROM public.orders WHERE customer_email LIKE '%@concurrency.test'`,
      )
      await database.query(
        `DELETE FROM public.customers WHERE email LIKE '%@concurrency.test'`,
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
      if (productIds.length > 0) {
        await database.query(
          'DELETE FROM public.products WHERE id = ANY($1::uuid[])',
          [productIds],
        )
      }
      if (originalSeller) {
        await restoreSeller(originalSeller)
      }
      await database.close()
    } finally {
      await releaseIntegration?.()
    }
  })

  it('keeps verification behind a registration that holds the payment lock', async () => {
    const session = await guestCart()
    const barrier = createBarrier()
    const registerCalls = []
    clientFactory = () =>
      createP24Client(sandboxP24, {
        async fetch(url, options) {
          registerCalls.push({ url: String(url), method: options.method })
          assert.equal(options.body.includes(sandboxP24.crcKey), false)
          assert.equal(options.body.includes(sandboxP24.secretId), false)
          barrier.markEntered()
          await barrier.released
          return {
            ok: true,
            status: 200,
            async text() {
              return `{"responseCode":0,"data":{"token":${JSON.stringify(TOKEN)}}}`
            },
          }
        },
      })
    const checkoutPromise = fetch(`${checkoutBaseUrl}/api/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': session.key,
        cookie: `shop_guest_session=${session.raw}`,
      },
      body: JSON.stringify({
        email: session.email,
        customerType: 'individual',
        paymentMethod: 'online',
        billing: {
          firstName: 'Anna',
          lastName: 'Nowak',
          street: 'Lipowa',
          buildingNumber: '1',
          postalCode: '00-001',
          city: 'Warszawa',
          countryCode: 'PL',
        },
      }),
    })

    try {
      await barrier.entered
      const held = await paymentByEmail(session.email)

      assert.equal(held.initialization_status, 'unknown')
      assert.equal(held.status, 'pending')
      assert.equal(held.payment_status, 'pending')
      assert.equal(held.redirect_token, null)
      assert.equal(held.provider_transaction_id, null)
      assert.equal(held.amount, '100')
      assert.equal(held.currency, 'PLN')
      assert.equal(held.gross_amount, '100')
      assert.equal(held.order_currency, 'PLN')
      assert.equal(held.reservation_status, 'active')
      assert.equal(held.stock_quantity, 8)
      assert.equal(await lockCount(held.id), 1)

      const blocked = await postWebhook(held.id)

      assert.equal(blocked.status, 503)
      assert.equal(blocked.payload.error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(verifyCalls.length, 0)
      assert.equal(registerCalls.length, 1)
      assert.deepEqual(await events(held.id), [])
      const during = await paymentByEmail(session.email)
      assert.equal(during.status, 'pending')
      assert.equal(during.payment_status, 'pending')
      assert.equal(during.initialization_status, 'unknown')
      assert.equal(during.redirect_token, null)
      assert.equal(during.amount, held.amount)
      assert.equal(during.currency, held.currency)
      assert.equal(during.reservation_status, 'active')
      assert.equal(during.stock_quantity, 8)
      assertNoSecrets(blocked.payload)
      assertNoSecrets(logs)

      barrier.release()
      const checkoutResponse = await checkoutPromise
      const checkoutPayload = await checkoutResponse.json()
      const registered = await paymentByEmail(session.email)

      assert.equal(checkoutResponse.status, 201)
      assert.equal(
        checkoutPayload.data.payment.initializationStatus,
        'registered',
      )
      assert.equal(registered.initialization_status, 'registered')
      assert.equal(registered.redirect_token, TOKEN)
      assert.equal(registered.status, 'pending')
      assert.equal(registered.payment_status, 'pending')
      assert.equal(registered.provider_transaction_id, null)
      assert.equal(registered.amount, '100')
      assert.equal(registered.currency, 'PLN')
      assert.equal(registerCalls.length, 1)
      assert.equal(
        registerCalls[0].url,
        'https://sandbox.przelewy24.pl/api/v1/transaction/register',
      )
      assertNoSecrets(checkoutPayload)

      const accepted = await postWebhook(held.id, blocked.orderId)
      const paid = await paymentByEmail(session.email)
      const paidHistory = await history(held.order_id)

      assert.equal(accepted.status, 202)
      assert.equal(accepted.payload.data.status, 'accepted')
      assert.equal(verifyCalls.length, 1)
      assert.equal(paid.status, 'paid')
      assert.equal(paid.payment_status, 'paid')
      assert.equal(paid.provider_transaction_id, blocked.orderId)
      assert.equal(paid.redirect_token, TOKEN)
      assert.equal(paid.amount, '100')
      assert.equal(paid.currency, 'PLN')
      assert.equal(paid.reservation_status, 'active')
      assert.equal(paid.stock_quantity, 8)
      assert.deepEqual(await events(held.id), [
        'verification_requested',
        'verification_accepted',
      ])
      assert.equal(
        paidHistory.filter((row) => row.new_status === 'paid').length,
        1,
      )
      assertNoSecrets(accepted.payload)

      const replay = await postWebhook(held.id, blocked.orderId)

      assert.equal(replay.status, 202)
      assert.equal(replay.payload.data.status, 'unchanged')
      assert.equal(verifyCalls.length, 1)
      assert.equal(registerCalls.length, 1)
      assert.equal((await history(held.order_id)).length, paidHistory.length)
      assert.equal(await lockCount(held.id), 0)
      assertNoSecrets(replay.payload)
      assertNoSecrets(logs)
    } finally {
      barrier.release()
      await checkoutPromise.catch(() => {})
    }
  })

  it('does not verify while reservation expiry holds the payment lock', async () => {
    const order = await createDueOrder()
    const blocker = new pg.Client({ connectionString: databaseUrl })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query(
      'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
      [order.orderId],
    )
    const worker = expireOnlineOrder(database, order.orderId)
    let released = false

    try {
      await waitForPaymentLock(order.paymentId)
      const blocked = await postWebhook(order.paymentId)

      assert.equal(blocked.status, 503)
      assert.equal(blocked.payload.error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(verifyCalls.length, 0)
      assert.deepEqual(await events(order.paymentId), [])
      const during = await paymentByEmail(order.email)
      assert.equal(during.status, 'pending')
      assert.equal(during.payment_status, 'pending')
      assert.equal(during.reservation_status, 'active')
      assert.equal(during.stock_quantity, 8)
      assert.equal((await history(order.orderId)).length, 0)
      assertNoSecrets(blocked.payload)
      assertNoSecrets(logs)

      await blocker.query('COMMIT')
      released = true
      const expired = await worker
      const afterWorker = await paymentByEmail(order.email)

      assert.equal(expired.expired, 1)
      assert.equal(afterWorker.reservation_status, 'expired')
      assert.equal(afterWorker.status, 'pending')
      assert.equal(afterWorker.payment_status, 'pending')
      assert.equal(afterWorker.stock_quantity, 8)
      assert.equal(await lockCount(order.paymentId), 0)

      const accepted = await postWebhook(order.paymentId, blocked.orderId)
      const paid = await paymentByEmail(order.email)

      assert.equal(accepted.status, 202)
      assert.equal(accepted.payload.data.status, 'accepted')
      assert.equal(verifyCalls.length, 1)
      assert.equal(paid.status, 'paid')
      assert.equal(paid.payment_status, 'paid')
      assert.equal(paid.provider_transaction_id, blocked.orderId)
      assert.equal(paid.reservation_status, 'expired')
      assert.equal(paid.stock_quantity, 8)
      assert.deepEqual(await events(order.paymentId), [
        'verification_requested',
        'verification_accepted',
      ])
      assert.deepEqual(await history(order.orderId), [
        {
          status_type: 'payment',
          old_status: 'pending',
          new_status: 'paid',
        },
      ])
      assertNoSecrets(accepted.payload)

      const replay = await postWebhook(order.paymentId, blocked.orderId)

      assert.equal(replay.status, 202)
      assert.equal(replay.payload.data.status, 'unchanged')
      assert.equal(verifyCalls.length, 1)
      assert.equal(await lockCount(order.paymentId), 0)
      assertNoSecrets(logs)
    } finally {
      if (!released) {
        await blocker.query('ROLLBACK')
      }
      await worker.catch(() => {})
      await blocker.end()
    }
  })

  it('lets expiry read a payment finalized under the same lock', async () => {
    const order = await createDueOrder()
    const barrier = createBarrier()
    hooks.beforeStage = (stage) => {
      if (stage !== 'event') {
        return undefined
      }

      hooks.beforeStage = null
      barrier.markEntered()
      return barrier.released
    }
    const webhookPromise = postWebhook(order.paymentId)

    try {
      await barrier.entered
      await assert.rejects(
        () =>
          expireOnlineOrder(database, order.orderId, { lockTimeoutMs: 200 }),
        (error) => error instanceof SessionLockTimeoutError,
      )
      const during = await paymentByEmail(order.email)

      assert.equal(verifyCalls.length, 1)
      assert.equal(during.status, 'pending')
      assert.equal(during.payment_status, 'pending')
      assert.equal(during.reservation_status, 'active')
      assert.equal(during.stock_quantity, 8)
      assert.deepEqual(await events(order.paymentId), [
        'verification_requested',
      ])
      assert.equal((await history(order.orderId)).length, 0)

      barrier.release()
      const accepted = await webhookPromise
      const paid = await paymentByEmail(order.email)

      assert.equal(accepted.status, 202)
      assert.equal(accepted.payload.data.status, 'accepted')
      assert.equal(paid.status, 'paid')
      assert.equal(paid.payment_status, 'paid')
      assert.equal(paid.reservation_status, 'active')
      assert.equal(paid.stock_quantity, 8)
      assert.deepEqual(await history(order.orderId), [
        {
          status_type: 'payment',
          old_status: 'pending',
          new_status: 'paid',
        },
      ])

      const skipped = await expireOnlineOrder(database, order.orderId, {
        lockTimeoutMs: 200,
      })
      const afterWorker = await paymentByEmail(order.email)

      assert.equal(skipped.transaction, true)
      assert.equal(skipped.expired, 0)
      assert.equal(afterWorker.reservation_status, 'active')
      assert.equal(afterWorker.status, 'paid')
      assert.equal(afterWorker.stock_quantity, 8)
      assert.equal(verifyCalls.length, 1)
      assert.equal(await lockCount(order.paymentId), 0)
      assertNoSecrets(accepted.payload)
      assertNoSecrets(logs)
    } finally {
      barrier.release()
      await webhookPromise.catch(() => {})
    }
  })
})
