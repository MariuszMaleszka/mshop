import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { createDatabase } from '../src/db/pool.js'
import {
  paymentAdvisoryLockKey,
  PAYMENT_ADVISORY_LOCK_NAMESPACE,
} from '../src/checkout/payment-lock.js'
import {
  expireOnlineOrder,
  runExpiryPass,
} from '../src/reservation-expiry/expire.js'
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
const secondDatabase = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    })
  : null
const productIds = []

describe('reservation expiry worker', { concurrency: 1, skip }, () => {
  before(async () => {
    if (!database) {
      return
    }

    const product = await database.query(
      `
        INSERT INTO public.products (
          name, slug, description, product_type, sku, price_amount, currency,
          tax_status, vat_rate, is_active, stock_quantity
        )
        VALUES (
          'Expiry product', $1, 'Expiry product', 'service', $2, 100, 'PLN',
          'exempt', NULL, true, 8
        )
        RETURNING id
      `,
      [`expiry-${randomUUID()}`, `sku-${randomUUID()}`],
    )
    productIds.push(product.rows[0].id)
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
          SELECT id FROM public.orders WHERE customer_email LIKE '%@expiry.test'
        )
      `,
      )
      await database.query(
        `
        DELETE FROM public.payments
        WHERE order_id IN (
          SELECT id FROM public.orders WHERE customer_email LIKE '%@expiry.test'
        )
      `,
      )
      await database.query(
        `DELETE FROM public.order_items
       WHERE order_id IN (
         SELECT id FROM public.orders WHERE customer_email LIKE '%@expiry.test'
       )`,
      )
      await database.query(
        `DELETE FROM public.orders WHERE customer_email LIKE '%@expiry.test'`,
      )
      if (productIds.length > 0) {
        await database.query(
          'DELETE FROM public.products WHERE id = ANY($1::uuid[])',
          [productIds],
        )
      }
      await database.close()
      await secondDatabase.close()
    } finally {
      await releaseIntegration?.()
    }
  })

  it('expires a due online reservation without changing stock or payment state', async () => {
    const order = await createOrder()
    const stockBefore = await stock()
    const first = await runExpiryPass(database)
    const second = await runExpiryPass(database)
    const stored = await reservationRows(order.orderId)

    assert.equal(first.expiredReservations, 1)
    assert.equal(second.expiredReservations, 0)
    assert.equal(stored[0].status, 'expired')
    assert.equal(stored[0].payment_status, 'pending')
    assert.equal(stored[0].payment_financial_status, 'pending')
    assert.equal(await stock(), stockBefore)
  })

  it('leaves a future online reservation and a cash reservation unchanged', async () => {
    const future = await createOrder({ expiresIn: '1 hour' })
    const cash = await createOrder({ method: 'cash' })

    await runExpiryPass(database)

    assert.equal((await reservationRows(future.orderId))[0].status, 'active')
    assert.equal((await reservationRows(cash.orderId))[0].status, 'active')
    assert.equal((await reservationRows(cash.orderId))[0].expires_at, null)
  })

  it('does not expire a paid order or a paid or partially refunded payment', async () => {
    const paidOrder = await createOrder({ orderStatus: 'paid' })
    const paidPayment = await createOrder({ paymentStatus: 'paid' })
    const partial = await createOrder({ paymentStatus: 'partially_refunded' })

    await runExpiryPass(database)

    assert.equal((await reservationRows(paidOrder.orderId))[0].status, 'active')
    assert.equal(
      (await reservationRows(paidPayment.orderId))[0].status,
      'active',
    )
    assert.equal((await reservationRows(partial.orderId))[0].status, 'active')
  })

  it('expires every due active reservation of an order together', async () => {
    const order = await createOrder({ lines: 2 })
    const result = await runExpiryPass(database)
    const rows = await reservationRows(order.orderId)

    assert.equal(result.expiredReservations, 2)
    assert.deepEqual(
      rows.map((row) => row.status),
      ['expired', 'expired'],
    )
  })

  it('expires nothing when one active reservation is still inside its deadline', async () => {
    const order = await createOrder({
      lines: [{ expiresIn: '-1 minute' }, { expiresIn: '1 hour' }],
    })

    await runExpiryPass(database)

    assert.deepEqual(
      (await reservationRows(order.orderId)).map((row) => row.status),
      ['active', 'active'],
    )
  })

  it('expires only the remaining due reservation when another is already expired', async () => {
    const due = await createOrder({
      lines: [{ status: 'expired' }, { expiresIn: '-1 minute' }],
    })
    const waiting = await createOrder({
      lines: [{ status: 'expired' }, { expiresIn: '1 hour' }],
    })

    await runExpiryPass(database)

    assert.deepEqual(
      (await reservationRows(due.orderId)).map((row) => row.status),
      ['expired', 'expired'],
    )
    assert.deepEqual(
      (await reservationRows(waiting.orderId)).map((row) => row.status).sort(),
      ['active', 'expired'],
    )
  })

  it('leaves an order unchanged when it has no active online reservations', async () => {
    const order = await createOrder({ lines: [{ status: 'released' }] })
    const result = await expireOnlineOrder(database, order.orderId, {
      lockTimeoutMs: 200,
    })

    assert.equal(result.transaction, true)
    assert.equal(result.expired, 0)
    assert.equal((await reservationRows(order.orderId))[0].status, 'released')
  })

  it('rolls back every reservation when the update count does not match', async () => {
    const order = await createOrder({ lines: 2 })
    const original = database.withSessionLock.bind(database)
    database.withSessionLock = (namespace, key, work, options) =>
      original(
        namespace,
        key,
        (session) =>
          work({
            ...session,
            transaction(callback) {
              return session.transaction((tx) =>
                callback({
                  query(text, params) {
                    if (text.includes('UPDATE public.inventory_reservations')) {
                      return tx.query(text, params).then((updated) => ({
                        ...updated,
                        rows: [],
                      }))
                    }

                    return tx.query(text, params)
                  },
                }),
              )
            },
          }),
        options,
      )

    try {
      const result = await expireOnlineOrder(database, order.orderId, {
        lockTimeoutMs: 200,
      })
      const rows = await reservationRows(order.orderId)

      assert.equal(result.expired, 0)
      assert.deepEqual(
        rows.map((row) => row.status),
        ['active', 'active'],
      )
    } finally {
      database.withSessionLock = original
    }
  })

  it('releases the payment lock and lets the next pass expire after a timeout', async () => {
    const blocked = await createOrder()
    const next = await createOrder({ expiresIn: '-2 minutes' })
    const holder = new pg.Client({ connectionString: databaseUrl })
    await holder.connect()
    await holder.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [
      PAYMENT_ADVISORY_LOCK_NAMESPACE,
      paymentAdvisoryLockKey(blocked.paymentId),
    ])

    try {
      await runExpiryPass(database, { lockTimeoutMs: 200 })
      assert.equal((await reservationRows(blocked.orderId))[0].status, 'active')
      assert.equal((await reservationRows(next.orderId))[0].status, 'expired')
    } finally {
      await holder.query(
        'SELECT pg_advisory_unlock($1::integer, $2::integer)',
        [
          PAYMENT_ADVISORY_LOCK_NAMESPACE,
          paymentAdvisoryLockKey(blocked.paymentId),
        ],
      )
      await holder.end()
    }

    await runExpiryPass(database, { lockTimeoutMs: 200 })
    assert.equal((await reservationRows(blocked.orderId))[0].status, 'expired')

    const probeClient = new pg.Client({ connectionString: databaseUrl })
    await probeClient.connect()
    const acquired = await probeClient.query(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked',
      [
        PAYMENT_ADVISORY_LOCK_NAMESPACE,
        paymentAdvisoryLockKey(blocked.paymentId),
      ],
    )
    assert.equal(acquired.rows[0].locked, true)
    await probeClient.query(
      'SELECT pg_advisory_unlock($1::integer, $2::integer)',
      [
        PAYMENT_ADVISORY_LOCK_NAMESPACE,
        paymentAdvisoryLockKey(blocked.paymentId),
      ],
    )
    await probeClient.end()
  })

  it('lets two workers expire the same due orders once', async () => {
    const first = await createOrder()
    const second = await createOrder({ expiresIn: '-3 minutes' })
    const results = await Promise.all([
      runExpiryPass(database),
      runExpiryPass(secondDatabase),
    ])

    assert.equal((await reservationRows(first.orderId))[0].status, 'expired')
    assert.equal((await reservationRows(second.orderId))[0].status, 'expired')
    assert.equal(results.length, 2)
  })

  it('pages past a payment-count problem and retries it on the next pass', async () => {
    const problem = await createOrder({
      extraFailedPayment: true,
      expiresIn: '-10 minutes',
    })
    const older = await createOrder({ expiresIn: '-5 minutes' })
    const newer = await createOrder({ expiresIn: '-4 minutes' })
    const first = await runExpiryPass(database, { pageSize: 1 })
    const second = await runExpiryPass(database, { pageSize: 1 })

    assert.equal((await reservationRows(problem.orderId))[0].status, 'active')
    assert.equal((await reservationRows(older.orderId))[0].status, 'expired')
    assert.equal((await reservationRows(newer.orderId))[0].status, 'expired')
    assert.equal(first.expiredOrders, 2)
    assert.equal(second.expiredOrders, 0)
  })

  it('stops fetching the next order when shutdown has started', async () => {
    const older = await createOrder({ expiresIn: '-30 days' })
    const newer = await createOrder({ expiresIn: '-29 days' })
    let checks = 0
    await runExpiryPass(database, {
      pageSize: 1,
      shouldStop() {
        checks += 1
        return checks > 2
      },
    })

    assert.equal((await reservationRows(older.orderId))[0].status, 'expired')
    assert.equal((await reservationRows(newer.orderId))[0].status, 'active')
  })
})

async function createOrder({
  method = 'online',
  expiresIn = '-1 minute',
  orderStatus = 'pending',
  paymentStatus = 'pending',
  lines = 1,
  extraFailedPayment = false,
} = {}) {
  const normalized = Array.isArray(lines)
    ? lines
    : Array.from({ length: lines }, () => ({ expiresIn, status: 'active' }))
  const gross = 100
  const email = `buyer-${randomUUID()}@expiry.test`
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
        $1, $2, 'individual', '{}'::jsonb, 'exempt', 'Expiry Seller',
        '5555555555', 'Lipowa', '1', '00-001', 'Warszawa', 'PL',
        'PLN', $3, 0, $3, $4, $5, 'new'
      )
      RETURNING id
    `,
    [`E${randomUUID().replaceAll('-', '')}`, email, gross, method, orderStatus],
  )
  const orderId = order.rows[0].id
  const reservationIds = []

  for (const line of normalized) {
    const item = await database.query(
      `
        INSERT INTO public.order_items (
          order_id, product_id, product_name_snapshot, product_type_snapshot,
          currency, catalog_tax_status_snapshot, tax_status_snapshot,
          unit_gross_amount, quantity, line_net_amount, line_tax_amount, line_gross_amount
        )
        VALUES (
          $1, $2, 'Expiry product', 'service', 'PLN', 'exempt', 'exempt',
          $3, 1, $3, 0, $3
        )
        RETURNING id
      `,
      [orderId, productIds[0], gross],
    )
    const reservation = await database.query(
      `
        INSERT INTO public.inventory_reservations (
          order_id, order_item_id, product_id, payment_method, quantity, status, expires_at
        )
        VALUES (
          $1, $2, $3, $4, 1, $5,
          CASE
            WHEN $4 = 'cash' THEN NULL
            ELSE clock_timestamp() + $6::interval
          END
        )
        RETURNING id
      `,
      [
        orderId,
        item.rows[0].id,
        productIds[0],
        method,
        line.status ?? 'active',
        line.expiresIn ?? expiresIn,
      ],
    )
    reservationIds.push(reservation.rows[0].id)
  }

  const payment = await database.query(
    `
      INSERT INTO public.payments (
        order_id, method, provider, status, amount, currency, paid_at,
        refunded_amount, initialization_status, redirect_token
      )
      VALUES (
        $1, $2, $3, $4, $5, 'PLN',
        CASE WHEN $4 IN ('paid', 'partially_refunded') THEN clock_timestamp() ELSE NULL END,
        CASE WHEN $4 = 'partially_refunded' THEN 40 ELSE 0 END,
        CASE WHEN $2 = 'online' THEN 'not_started' ELSE NULL END,
        NULL
      )
      RETURNING id
    `,
    [
      orderId,
      method,
      method === 'online' ? 'przelewy24' : null,
      paymentStatus,
      gross,
    ],
  )

  if (extraFailedPayment) {
    await database.query(
      `
        INSERT INTO public.payments (
          order_id, method, provider, status, amount, currency,
          initialization_status
        )
        VALUES ($1, 'online', 'przelewy24', 'failed', $2, 'PLN', 'not_started')
      `,
      [orderId, gross],
    )
  }

  return { orderId, paymentId: payment.rows[0].id, reservationIds }
}

async function reservationRows(orderId) {
  const result = await database.query(
    `
      SELECT
        r.status,
        r.expires_at,
        o.payment_status,
        p.status AS payment_financial_status
      FROM public.inventory_reservations AS r
      JOIN public.orders AS o ON o.id = r.order_id
      JOIN public.payments AS p ON p.order_id = o.id AND p.status <> 'failed'
      WHERE r.order_id = $1
      ORDER BY r.id
    `,
    [orderId],
  )
  return result.rows
}

async function stock() {
  const result = await database.query(
    'SELECT stock_quantity FROM public.products WHERE id = $1',
    [productIds[0]],
  )
  return result.rows[0].stock_quantity
}
