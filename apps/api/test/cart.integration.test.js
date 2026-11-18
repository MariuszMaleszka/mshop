import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerCartRoutes } from '../src/cart/routes.js'
import {
  addAccountCartItem,
  addGuestCartItem,
  deleteAccountCartItem,
  findAccountCart,
  updateAccountCartItem,
  updateGuestCartItem,
} from '../src/cart/repository.js'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { loadConfig } from '../src/config.js'
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
const sessionHashes = []
const productIds = []
const userIds = []

function sessionHash() {
  const hash = hashGuestSessionId(randomBytes(32).toString('hex'))
  sessionHashes.push(hash)
  return hash
}

async function insertProduct(price) {
  const result = await database.query(
    `
      INSERT INTO public.products (
        name, slug, description, product_type, sku, price_amount, currency,
        tax_status, vat_rate, is_active
      )
      VALUES ($1, $2, $3, 'service', $4, $5, 'PLN', 'standard', 23, true)
      RETURNING id
    `,
    [
      'Cart race',
      `cart-race-${randomUUID()}`,
      'Cart race',
      `sku-${randomUUID()}`,
      price,
    ],
  )
  productIds.push(result.rows[0].id)
  return result.rows[0].id
}

async function quantities(hash) {
  const result = await database.query(
    `
      SELECT ci.product_id, ci.quantity, count(*) OVER () AS carts
      FROM public.cart_items AS ci
      JOIN public.carts AS c ON c.id = ci.cart_id
      WHERE c.session_id = $1
        AND c.user_id IS NULL
        AND c.status = 'active'
    `,
    [hash],
  )
  const carts = await database.query(
    `
      SELECT count(*)::int AS total
      FROM public.carts
      WHERE session_id = $1 AND status = 'active'
    `,
    [hash],
  )
  return { rows: result.rows, carts: carts.rows[0].total }
}

describe('guest cart concurrency', { concurrency: 1 }, () => {
  after(async () => {
    if (!database) {
      return
    }

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

    await database.close()
  })

  it(
    'stores both first adds for one session in one active cart',
    { skip },
    async () => {
      const hash = sessionHash()
      const first = await insertProduct('1000')
      const second = await insertProduct('2500')
      const [left, right] = await Promise.all([
        addGuestCartItem(database, hash, { productId: first, quantity: 1 }),
        addGuestCartItem(database, hash, { productId: second, quantity: 2 }),
      ])
      const stored = await quantities(hash)

      assert.equal(left.outcome, 'ready')
      assert.equal(right.outcome, 'ready')
      assert.equal(stored.carts, 1)
      assert.equal(stored.rows.length, 2)
      assert.equal(
        stored.rows.find((row) => row.product_id === first).quantity,
        1,
      )
      assert.equal(
        stored.rows.find((row) => row.product_id === second).quantity,
        2,
      )
    },
  )

  it(
    'sums parallel quantity increases of the same product',
    { skip },
    async () => {
      const hash = sessionHash()
      const product = await insertProduct('1500')
      const seeded = await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 4,
      })
      const [left, right] = await Promise.all([
        addGuestCartItem(database, hash, { productId: product, quantity: 3 }),
        addGuestCartItem(database, hash, { productId: product, quantity: 5 }),
      ])
      const stored = await quantities(hash)

      assert.equal(seeded.outcome, 'ready')
      assert.equal(left.outcome, 'ready')
      assert.equal(right.outcome, 'ready')
      assert.equal(stored.carts, 1)
      assert.equal(stored.rows.length, 1)
      assert.equal(stored.rows[0].quantity, 12)
    },
  )

  it(
    'rejects an integer overflow and an amount the API cannot represent',
    { skip },
    async () => {
      const hash = sessionHash()
      const counted = await insertProduct('10')
      const expensive = await insertProduct('5000000000000000')
      await addGuestCartItem(database, hash, {
        productId: counted,
        quantity: 2147483646,
      })

      const overflow = await addGuestCartItem(database, hash, {
        productId: counted,
        quantity: 2,
      })
      const afterOverflow = await quantities(hash)
      const app = createApp(config, {
        database,
        registerRoutes(router) {
          registerCartRoutes(router, { database })
        },
      })
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
      })

      try {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/v1/cart/items`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: `shop_guest_session=${'ef'.repeat(32)}`,
            },
            body: JSON.stringify({ productId: expensive, quantity: 2 }),
          },
        )
        const body = await response.json()
        const stored = await database.query(
          `
          SELECT count(*)::int AS total
          FROM public.cart_items
          WHERE product_id = $1
        `,
          [expensive],
        )

        assert.equal(overflow.outcome, 'overflow')
        assert.equal(afterOverflow.rows[0].quantity, 2147483646)
        assert.equal(response.status, 400)
        assert.equal(body.error.code, 'VALIDATION_ERROR')
        assert.equal(body.error.details[0].path, 'total_amount')
        assert.equal(stored.rows[0].total, 0)
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }

            resolve()
          })
        })
      }
    },
  )

  it(
    'rejects a patch that would make the cart amount unrepresentable',
    { skip },
    async () => {
      const hash = sessionHash()
      const product = await insertProduct('5000000000000000')
      await database.query(
        `
        INSERT INTO public.carts (session_id, currency)
        VALUES ($1, 'PLN')
      `,
        [hash],
      )
      const cart = await database.query(
        'SELECT id FROM public.carts WHERE session_id = $1',
        [hash],
      )
      const item = await database.query(
        `
        INSERT INTO public.cart_items (cart_id, product_id, quantity)
        VALUES ($1, $2, 1)
        RETURNING id
      `,
        [cart.rows[0].id, product],
      )
      let failed = false

      try {
        await updateGuestCartItem(database, hash, {
          itemId: item.rows[0].id,
          quantity: 2,
        })
      } catch (error) {
        failed = error.name === 'CartAmountError'
      }

      const stored = await database.query(
        'SELECT quantity FROM public.cart_items WHERE id = $1',
        [item.rows[0].id],
      )

      assert.equal(failed, true)
      assert.equal(stored.rows[0].quantity, 1)
    },
  )

  it(
    'stores both first account adds for one user in one active cart',
    { skip },
    async () => {
      const user = await insertUser()
      const first = await insertProduct('1000')
      const second = await insertProduct('2500')
      const [left, right] = await Promise.all([
        addAccountCartItem(database, user, { productId: first, quantity: 1 }),
        addAccountCartItem(database, user, { productId: second, quantity: 2 }),
      ])
      const stored = await accountQuantities(user)

      assert.equal(left.outcome, 'ready')
      assert.equal(right.outcome, 'ready')
      assert.equal(stored.carts, 1)
      assert.equal(stored.rows.length, 2)
      assert.equal(
        stored.rows.find((row) => row.product_id === first).quantity,
        1,
      )
      assert.equal(
        stored.rows.find((row) => row.product_id === second).quantity,
        2,
      )
    },
  )

  it(
    'sums parallel account quantity increases of the same product',
    { skip },
    async () => {
      const user = await insertUser()
      const product = await insertProduct('1500')
      const seeded = await addAccountCartItem(database, user, {
        productId: product,
        quantity: 4,
      })
      const [left, right] = await Promise.all([
        addAccountCartItem(database, user, { productId: product, quantity: 3 }),
        addAccountCartItem(database, user, { productId: product, quantity: 5 }),
      ])
      const stored = await accountQuantities(user)

      assert.equal(seeded.outcome, 'ready')
      assert.equal(left.outcome, 'ready')
      assert.equal(right.outcome, 'ready')
      assert.equal(stored.carts, 1)
      assert.equal(stored.rows.length, 1)
      assert.equal(stored.rows[0].quantity, 12)
    },
  )

  it(
    'keeps the guest cart and the account cart as separate rows',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1800')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 2,
      })
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 5,
      })
      const guest = await quantities(hash)
      const account = await accountQuantities(user)
      const owners = await database.query(
        `
          SELECT user_id, session_id
          FROM public.carts
          WHERE id IN (
            SELECT cart_id FROM public.cart_items WHERE product_id = $1
          )
        `,
        [product],
      )

      assert.equal(guest.carts, 1)
      assert.equal(guest.rows[0].quantity, 2)
      assert.equal(account.carts, 1)
      assert.equal(account.rows[0].quantity, 5)
      assert.equal(owners.rows.length, 2)
      assert.equal(
        owners.rows.filter(
          (row) => row.user_id === user && row.session_id === null,
        ).length,
        1,
      )
      assert.equal(
        owners.rows.filter(
          (row) => row.user_id === null && row.session_id === hash,
        ).length,
        1,
      )
    },
  )

  it(
    'does not change guest lines while changing the account cart',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('2100')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 2,
      })
      const added = await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })
      const account = await accountQuantities(user)
      const updated = await updateAccountCartItem(database, user, {
        itemId: account.rows[0].id,
        quantity: 4,
      })
      const guest = await quantities(hash)

      assert.equal(added.outcome, 'ready')
      assert.equal(updated, true)
      assert.equal(guest.rows.length, 1)
      assert.equal(guest.rows[0].quantity, 2)
    },
  )

  it(
    'hides another account cart from reads, updates and deletes',
    { skip },
    async () => {
      const owner = await insertUser()
      const stranger = await insertUser()
      const product = await insertProduct('2600')
      await addAccountCartItem(database, owner, {
        productId: product,
        quantity: 3,
      })
      const owned = await accountQuantities(owner)
      const seen = await findAccountCart(database, stranger)
      const updated = await updateAccountCartItem(database, stranger, {
        itemId: owned.rows[0].id,
        quantity: 9,
      })
      const removed = await deleteAccountCartItem(
        database,
        stranger,
        owned.rows[0].id,
      )
      const stored = await accountQuantities(owner)
      const app = createApp(config, {
        database,
        accessTokens: {
          async verifyAccessToken() {
            return stranger
          },
        },
        registerRoutes(router) {
          registerCartRoutes(router, { database })
        },
      })
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
      })

      try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`
        const headers = { authorization: 'Bearer account-test' }
        const read = await fetch(`${baseUrl}/api/v1/cart`, { headers })
        const readBody = await read.json()
        const response = await fetch(
          `${baseUrl}/api/v1/cart/items/${owned.rows[0].id}`,
          {
            method: 'PATCH',
            headers: {
              ...headers,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ quantity: 8, user_id: owner }),
          },
        )
        const removedResponse = await fetch(
          `${baseUrl}/api/v1/cart/items/${owned.rows[0].id}`,
          { method: 'DELETE', headers },
        )
        const afterHttp = await accountQuantities(owner)

        assert.deepEqual(seen.items, [])
        assert.equal(seen.total_amount, 0)
        assert.equal(updated, false)
        assert.equal(removed, false)
        assert.equal(stored.rows[0].quantity, 3)
        assert.equal(read.status, 200)
        assert.deepEqual(readBody.data.items, [])
        assert.equal(response.status, 404)
        assert.equal(removedResponse.status, 404)
        assert.equal(afterHttp.rows[0].quantity, 3)
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }

            resolve()
          })
        })
      }
    },
  )
})

async function insertUser() {
  const id = randomUUID()
  await database.query('INSERT INTO auth.users (id) VALUES ($1)', [id])
  userIds.push(id)
  return id
}

async function accountQuantities(user) {
  const result = await database.query(
    `
      SELECT ci.id, ci.product_id, ci.quantity
      FROM public.cart_items AS ci
      JOIN public.carts AS c ON c.id = ci.cart_id
      WHERE c.user_id = $1
        AND c.session_id IS NULL
        AND c.status = 'active'
    `,
    [user],
  )
  const carts = await database.query(
    `
      SELECT count(*)::int AS total
      FROM public.carts
      WHERE user_id = $1
        AND session_id IS NULL
        AND status = 'active'
    `,
    [user],
  )
  return { rows: result.rows, carts: carts.rows[0].total }
}
