import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerCartRoutes } from '../src/cart/routes.js'
import {
  ACCOUNT_CART_LOCK_NAMESPACE,
  GUEST_CART_LOCK_NAMESPACE,
  accountCartLockKey,
  CartAmountError,
  CartMergeError,
  addAccountCartItem,
  addGuestCartItem,
  deleteAccountCartItem,
  deleteGuestCartItem,
  findAccountCart,
  guestCartLockKey,
  mergeGuestCart,
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

async function insertProduct(
  price,
  { currency = 'PLN', isActive = true } = {},
) {
  const result = await database.query(
    `
      INSERT INTO public.products (
        name, slug, description, product_type, sku, price_amount, currency,
        tax_status, vat_rate, is_active
      )
      VALUES ($1, $2, $3, 'service', $4, $5, $6, 'standard', 23, $7)
      RETURNING id
    `,
    [
      'Cart race',
      `cart-race-${randomUUID()}`,
      'Cart race',
      `sku-${randomUUID()}`,
      price,
      currency,
      isActive,
    ],
  )
  productIds.push(result.rows[0].id)
  return result.rows[0].id
}

async function quantities(hash) {
  const result = await database.query(
    `
      SELECT ci.id, ci.product_id, ci.quantity, count(*) OVER () AS carts
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

  it(
    'waits to create a guest cart while that owner lock is held',
    { skip },
    async () => {
      const hash = sessionHash()
      const product = await insertProduct('1100')
      const key = guestCartLockKey(hash)

      await withHeldLock(GUEST_CART_LOCK_NAMESPACE, key, {
        run: () =>
          addGuestCartItem(database, hash, { productId: product, quantity: 1 }),
        unchanged: async () => {
          const stored = await quantities(hash)
          assert.equal(stored.carts, 0)
        },
        changed: async () => {
          const stored = await quantities(hash)
          assert.equal(stored.carts, 1)
          assert.equal(stored.rows[0].quantity, 1)
        },
      })
    },
  )

  it(
    'holds the guest lock before changing an existing guest cart',
    { skip },
    async () => {
      const hash = sessionHash()
      const product = await insertProduct('1200')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })

      await whileBlockedOnRow(
        GUEST_CART_LOCK_NAMESPACE,
        guestCartLockKey(hash),
        'SELECT id FROM public.carts WHERE session_id = $1 FOR UPDATE',
        [hash],
        () =>
          addGuestCartItem(database, hash, { productId: product, quantity: 2 }),
      )

      const stored = await quantities(hash)
      assert.equal(stored.rows[0].quantity, 3)
    },
  )

  it(
    'waits to patch a guest line while that owner lock is held',
    { skip },
    async () => {
      const hash = sessionHash()
      const product = await insertProduct('1300')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })
      const stored = await quantities(hash)

      await withHeldLock(GUEST_CART_LOCK_NAMESPACE, guestCartLockKey(hash), {
        run: () =>
          updateGuestCartItem(database, hash, {
            itemId: stored.rows[0].id,
            quantity: 6,
          }),
        unchanged: async () => {
          const current = await quantities(hash)
          assert.equal(current.rows[0].quantity, 1)
        },
        changed: async () => {
          const current = await quantities(hash)
          assert.equal(current.rows[0].quantity, 6)
        },
      })
    },
  )

  it(
    'waits to delete a guest line while that owner lock is held',
    { skip },
    async () => {
      const hash = sessionHash()
      const product = await insertProduct('1400')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })
      const stored = await quantities(hash)

      await withHeldLock(GUEST_CART_LOCK_NAMESPACE, guestCartLockKey(hash), {
        run: () => deleteGuestCartItem(database, hash, stored.rows[0].id),
        unchanged: async () => {
          const current = await quantities(hash)
          assert.equal(current.rows.length, 1)
        },
        changed: async () => {
          const current = await quantities(hash)
          assert.equal(current.rows.length, 0)
        },
      })
    },
  )

  it(
    'holds the guest lock before deleting a guest line',
    { skip },
    async () => {
      const hash = sessionHash()
      const product = await insertProduct('1500')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })
      const stored = await quantities(hash)

      await whileBlockedOnRow(
        GUEST_CART_LOCK_NAMESPACE,
        guestCartLockKey(hash),
        'SELECT id FROM public.cart_items WHERE id = $1 FOR UPDATE',
        [stored.rows[0].id],
        () => deleteGuestCartItem(database, hash, stored.rows[0].id),
      )

      const current = await quantities(hash)
      assert.equal(current.rows.length, 0)
    },
  )

  it(
    'waits to create an account cart while that owner lock is held',
    { skip },
    async () => {
      const user = await insertUser()
      const product = await insertProduct('1600')

      await withHeldLock(
        ACCOUNT_CART_LOCK_NAMESPACE,
        accountCartLockKey(user),
        {
          run: () =>
            addAccountCartItem(database, user, {
              productId: product,
              quantity: 1,
            }),
          unchanged: async () => {
            const stored = await accountQuantities(user)
            assert.equal(stored.carts, 0)
          },
          changed: async () => {
            const stored = await accountQuantities(user)
            assert.equal(stored.carts, 1)
            assert.equal(stored.rows[0].quantity, 1)
          },
        },
      )
    },
  )

  it(
    'holds the account lock before changing an existing account cart',
    { skip },
    async () => {
      const user = await insertUser()
      const product = await insertProduct('1700')
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })

      await whileBlockedOnRow(
        ACCOUNT_CART_LOCK_NAMESPACE,
        accountCartLockKey(user),
        'SELECT id FROM public.carts WHERE user_id = $1 FOR UPDATE',
        [user],
        () =>
          addAccountCartItem(database, user, {
            productId: product,
            quantity: 4,
          }),
      )

      const stored = await accountQuantities(user)
      assert.equal(stored.rows[0].quantity, 5)
    },
  )

  it(
    'waits to patch an account line while that owner lock is held',
    { skip },
    async () => {
      const user = await insertUser()
      const product = await insertProduct('1800')
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })
      const stored = await accountQuantities(user)

      await withHeldLock(
        ACCOUNT_CART_LOCK_NAMESPACE,
        accountCartLockKey(user),
        {
          run: () =>
            updateAccountCartItem(database, user, {
              itemId: stored.rows[0].id,
              quantity: 7,
            }),
          unchanged: async () => {
            const current = await accountQuantities(user)
            assert.equal(current.rows[0].quantity, 1)
          },
          changed: async () => {
            const current = await accountQuantities(user)
            assert.equal(current.rows[0].quantity, 7)
          },
        },
      )
    },
  )

  it(
    'waits to delete an account line while that owner lock is held',
    { skip },
    async () => {
      const user = await insertUser()
      const product = await insertProduct('1900')
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })
      const stored = await accountQuantities(user)

      await withHeldLock(
        ACCOUNT_CART_LOCK_NAMESPACE,
        accountCartLockKey(user),
        {
          run: () => deleteAccountCartItem(database, user, stored.rows[0].id),
          unchanged: async () => {
            const current = await accountQuantities(user)
            assert.equal(current.rows.length, 1)
          },
          changed: async () => {
            const current = await accountQuantities(user)
            assert.equal(current.rows.length, 0)
          },
        },
      )
    },
  )

  it(
    'holds the account lock before deleting an account line',
    { skip },
    async () => {
      const user = await insertUser()
      const product = await insertProduct('2000')
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })
      const stored = await accountQuantities(user)

      await whileBlockedOnRow(
        ACCOUNT_CART_LOCK_NAMESPACE,
        accountCartLockKey(user),
        'SELECT id FROM public.cart_items WHERE id = $1 FOR UPDATE',
        [stored.rows[0].id],
        () => deleteAccountCartItem(database, user, stored.rows[0].id),
      )

      const current = await accountQuantities(user)
      assert.equal(current.rows.length, 0)
    },
  )

  it(
    'holds the account lock before patching an account line',
    { skip },
    async () => {
      const user = await insertUser()
      const product = await insertProduct('2100')
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })
      const stored = await accountQuantities(user)

      await whileBlockedOnRow(
        ACCOUNT_CART_LOCK_NAMESPACE,
        accountCartLockKey(user),
        'SELECT id FROM public.cart_items WHERE id = $1 FOR UPDATE',
        [stored.rows[0].id],
        () =>
          updateAccountCartItem(database, user, {
            itemId: stored.rows[0].id,
            quantity: 4,
          }),
      )

      const current = await accountQuantities(user)
      assert.equal(current.rows[0].quantity, 4)
    },
  )

  it(
    'transfers the guest cart when the account has no cart',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1500')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 2,
      })
      const before = await database.query(
        `
        SELECT c.id AS cart_id, ci.id AS item_id
        FROM public.carts AS c
        JOIN public.cart_items AS ci ON ci.cart_id = c.id
        WHERE c.session_id = $1
      `,
        [hash],
      )

      await mergeGuestCart(database, user, hash)

      const moved = await database.query(
        `
        SELECT id, user_id, session_id, status
        FROM public.carts
        WHERE id = $1
      `,
        [before.rows[0].cart_id],
      )
      const account = await accountQuantities(user)
      const guest = await quantities(hash)

      assert.equal(moved.rows[0].user_id, user)
      assert.equal(moved.rows[0].session_id, null)
      assert.equal(moved.rows[0].status, 'active')
      assert.equal(account.rows[0].id, before.rows[0].item_id)
      assert.equal(account.rows[0].quantity, 2)
      assert.equal(guest.carts, 0)
    },
  )

  it('sums both carts once and abandons the guest cart', { skip }, async () => {
    const user = await insertUser()
    const hash = sessionHash()
    const shared = await insertProduct('2000')
    const guestOnly = await insertProduct('3000', { isActive: false })
    await addAccountCartItem(database, user, {
      productId: shared,
      quantity: 2,
    })
    await addGuestCartItem(database, hash, { productId: shared, quantity: 3 })
    const guestCart = await database.query(
      'SELECT id FROM public.carts WHERE session_id = $1',
      [hash],
    )
    await database.query(
      `
        INSERT INTO public.cart_items (cart_id, product_id, quantity)
        VALUES ($1, $2, 4)
      `,
      [guestCart.rows[0].id, guestOnly],
    )
    const accountBefore = await accountQuantities(user)

    await mergeGuestCart(database, user, hash)
    await mergeGuestCart(database, user, hash)

    const account = await accountQuantities(user)
    const guest = await database.query(
      `
        SELECT status, session_id, user_id
        FROM public.carts
        WHERE id = $1
      `,
      [guestCart.rows[0].id],
    )
    const sharedLine = account.rows.find((row) => row.product_id === shared)
    const movedLine = account.rows.find((row) => row.product_id === guestOnly)

    assert.equal(sharedLine.id, accountBefore.rows[0].id)
    assert.equal(sharedLine.quantity, 5)
    assert.equal(movedLine.quantity, 4)
    assert.equal(movedLine.id === accountBefore.rows[0].id, false)
    assert.equal(guest.rows[0].status, 'abandoned')
    assert.equal(guest.rows[0].session_id, hash)
    assert.equal(guest.rows[0].user_id, null)
    assert.equal(account.carts, 1)
  })

  it(
    'leaves an empty guest cart active and creates no account cart',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const created = await database.query(
        `
        INSERT INTO public.carts (session_id, currency)
        VALUES ($1, 'PLN')
        RETURNING id
      `,
        [hash],
      )

      await mergeGuestCart(database, user, hash)

      const guest = await database.query(
        'SELECT status, session_id FROM public.carts WHERE id = $1',
        [created.rows[0].id],
      )
      const account = await accountQuantities(user)

      assert.equal(guest.rows[0].status, 'active')
      assert.equal(guest.rows[0].session_id, hash)
      assert.equal(account.carts, 0)
    },
  )

  it(
    'rolls back a non-PLN line, a non-PLN cart, and an unsafe total',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const foreign = await insertProduct('1000', { currency: 'EUR' })
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
        VALUES ($1, $2, 1)
      `,
        [cart.rows[0].id, foreign],
      )

      await assert.rejects(
        mergeGuestCart(database, user, hash),
        (error) =>
          error instanceof CartMergeError && error.reason === 'currency',
      )

      const priced = sessionHash()
      const expensive = await insertProduct('9007199254740991')
      await addGuestCartItem(database, priced, {
        productId: expensive,
        quantity: 1,
      })
      await database.query(
        `
        UPDATE public.cart_items AS ci
        SET quantity = 2
        FROM public.carts AS c
        WHERE ci.cart_id = c.id
          AND c.session_id = $1
      `,
        [priced],
      )

      await assert.rejects(
        mergeGuestCart(database, user, priced),
        (error) => error instanceof CartAmountError,
      )

      const foreignCart = sessionHash()
      const plain = await insertProduct('1000')
      const stored = await database.query(
        `
        INSERT INTO public.carts (session_id, currency)
        VALUES ($1, 'EUR')
        RETURNING id
      `,
        [foreignCart],
      )
      await database.query(
        `
        INSERT INTO public.cart_items (cart_id, product_id, quantity)
        VALUES ($1, $2, 1)
      `,
        [stored.rows[0].id, plain],
      )

      await assert.rejects(
        mergeGuestCart(database, user, foreignCart),
        (error) =>
          error instanceof CartMergeError && error.reason === 'currency',
      )

      const stillGuest = await database.query(
        `
        SELECT status
        FROM public.carts
        WHERE session_id = ANY($1::char(64)[])
      `,
        [[hash, priced, foreignCart]],
      )
      const account = await accountQuantities(user)

      assert.equal(stillGuest.rows.length, 3)
      assert.equal(
        stillGuest.rows.every((row) => row.status === 'active'),
        true,
      )
      assert.equal(account.carts, 0)
    },
  )

  it('rolls back a quantity above the integer maximum', { skip }, async () => {
    const user = await insertUser()
    const hash = sessionHash()
    const product = await insertProduct('1000')
    await addAccountCartItem(database, user, {
      productId: product,
      quantity: 1,
    })
    await addGuestCartItem(database, hash, { productId: product, quantity: 1 })
    await database.query(
      `
        UPDATE public.cart_items
        SET quantity = 2000000000
        WHERE product_id = $1
      `,
      [product],
    )

    await assert.rejects(
      mergeGuestCart(database, user, hash),
      (error) => error instanceof CartMergeError && error.reason === 'quantity',
    )

    const account = await accountQuantities(user)
    const guest = await quantities(hash)

    assert.equal(account.rows[0].quantity, 2000000000)
    assert.equal(guest.rows[0].quantity, 2000000000)
    assert.equal(guest.carts, 1)
  })

  it(
    'applies one merge when two merges wait on the same guest',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1000')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })
      const key = guestCartLockKey(hash)
      const holder = new pg.Client({ connectionString: databaseUrl })
      await holder.connect()
      const pending = []

      try {
        await holder.query('BEGIN')
        await holder.query(
          'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
          [GUEST_CART_LOCK_NAMESPACE, key],
        )
        pending.push(mergeGuestCart(database, user, hash))
        await waitForUnGranted(holder, GUEST_CART_LOCK_NAMESPACE, key, 1)
        pending.push(mergeGuestCart(database, user, hash))
        await waitForUnGranted(holder, GUEST_CART_LOCK_NAMESPACE, key, 2)
        const during = await quantities(hash)
        assert.equal(during.rows[0].quantity, 1)
        await holder.query('COMMIT')
        await Promise.all(pending)
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end()
        await Promise.allSettled(pending)
      }

      const account = await accountQuantities(user)
      const activeGuest = await quantities(hash)

      assert.equal(account.rows[0].quantity, 1)
      assert.equal(account.carts, 1)
      assert.equal(activeGuest.carts, 0)
    },
  )

  it(
    'merges two guest carts into one account without duplicating lines',
    { skip },
    async () => {
      const user = await insertUser()
      const firstHash = sessionHash()
      const secondHash = sessionHash()
      const firstProduct = await insertProduct('1000')
      const secondProduct = await insertProduct('1100')
      await addGuestCartItem(database, firstHash, {
        productId: firstProduct,
        quantity: 1,
      })
      await addGuestCartItem(database, secondHash, {
        productId: secondProduct,
        quantity: 1,
      })
      const key = accountCartLockKey(user)
      const holder = new pg.Client({ connectionString: databaseUrl })
      await holder.connect()
      const pending = []

      try {
        await holder.query('BEGIN')
        await holder.query(
          'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
          [ACCOUNT_CART_LOCK_NAMESPACE, key],
        )
        pending.push(mergeGuestCart(database, user, firstHash))
        pending.push(mergeGuestCart(database, user, secondHash))
        await waitForUnGranted(holder, ACCOUNT_CART_LOCK_NAMESPACE, key, 2)
        assert.equal((await quantities(firstHash)).rows[0].quantity, 1)
        assert.equal((await quantities(secondHash)).rows[0].quantity, 1)
        await holder.query('COMMIT')
        await Promise.all(pending)
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end()
        await Promise.allSettled(pending)
      }

      const account = await accountQuantities(user)

      assert.equal(account.carts, 1)
      assert.equal(account.rows.length, 2)
      assert.equal(
        account.rows.reduce((sum, row) => sum + row.quantity, 0),
        2,
      )
    },
  )

  it(
    'merges the guest quantity written by the waiting add',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1000')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })

      await finishInOrder({
        lockSql: 'SELECT id FROM public.carts WHERE session_id = $1 FOR UPDATE',
        lockParams: [hash],
        first: () =>
          addGuestCartItem(database, hash, { productId: product, quantity: 2 }),
        firstNamespace: GUEST_CART_LOCK_NAMESPACE,
        firstKey: guestCartLockKey(hash),
        second: () => mergeGuestCart(database, user, hash),
        secondNamespace: GUEST_CART_LOCK_NAMESPACE,
        secondKey: guestCartLockKey(hash),
      })

      const account = await accountQuantities(user)
      assert.equal(account.rows[0].quantity, 3)
      assert.equal((await quantities(hash)).carts, 0)
    },
  )

  it(
    'keeps a later guest add on a new cart after the merge',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1000')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })

      await finishInOrder({
        lockSql: 'SELECT id FROM public.carts WHERE session_id = $1 FOR UPDATE',
        lockParams: [hash],
        first: () => mergeGuestCart(database, user, hash),
        firstNamespace: GUEST_CART_LOCK_NAMESPACE,
        firstKey: guestCartLockKey(hash),
        second: () =>
          addGuestCartItem(database, hash, { productId: product, quantity: 2 }),
        secondNamespace: GUEST_CART_LOCK_NAMESPACE,
        secondKey: guestCartLockKey(hash),
      })

      const account = await accountQuantities(user)
      const guest = await quantities(hash)

      assert.equal(account.rows[0].quantity, 1)
      assert.equal(guest.carts, 1)
      assert.equal(guest.rows[0].quantity, 2)
    },
  )

  it(
    'merges a guest line after a waiting patch and skips a deleted line',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1000')
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })
      const stored = await quantities(hash)

      await finishInOrder({
        lockSql: 'SELECT id FROM public.carts WHERE session_id = $1 FOR UPDATE',
        lockParams: [hash],
        first: () =>
          updateGuestCartItem(database, hash, {
            itemId: stored.rows[0].id,
            quantity: 6,
          }),
        firstNamespace: GUEST_CART_LOCK_NAMESPACE,
        firstKey: guestCartLockKey(hash),
        second: () => mergeGuestCart(database, user, hash),
        secondNamespace: GUEST_CART_LOCK_NAMESPACE,
        secondKey: guestCartLockKey(hash),
      })

      assert.equal((await accountQuantities(user)).rows[0].quantity, 6)

      const otherHash = sessionHash()
      const otherProduct = await insertProduct('1200')
      await addGuestCartItem(database, otherHash, {
        productId: otherProduct,
        quantity: 1,
      })
      const other = await quantities(otherHash)

      await finishInOrder({
        lockSql: 'SELECT id FROM public.cart_items WHERE id = $1 FOR UPDATE',
        lockParams: [other.rows[0].id],
        first: () => deleteGuestCartItem(database, otherHash, other.rows[0].id),
        firstNamespace: GUEST_CART_LOCK_NAMESPACE,
        firstKey: guestCartLockKey(otherHash),
        second: () => mergeGuestCart(database, user, otherHash),
        secondNamespace: GUEST_CART_LOCK_NAMESPACE,
        secondKey: guestCartLockKey(otherHash),
      })

      const account = await accountQuantities(user)
      const guest = await database.query(
        `
        SELECT status
        FROM public.carts
        WHERE session_id = $1
      `,
        [otherHash],
      )

      assert.equal(
        account.rows.some((row) => row.product_id === otherProduct),
        false,
      )
      assert.equal(guest.rows[0].status, 'active')
    },
  )

  it(
    'merges around a waiting account add and a waiting account delete',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1000')
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })

      await finishInOrder({
        lockSql: 'SELECT id FROM public.carts WHERE user_id = $1 FOR UPDATE',
        lockParams: [user],
        first: () =>
          addAccountCartItem(database, user, {
            productId: product,
            quantity: 4,
          }),
        firstNamespace: ACCOUNT_CART_LOCK_NAMESPACE,
        firstKey: accountCartLockKey(user),
        second: () => mergeGuestCart(database, user, hash),
        secondNamespace: ACCOUNT_CART_LOCK_NAMESPACE,
        secondKey: accountCartLockKey(user),
      })

      assert.equal((await accountQuantities(user)).rows[0].quantity, 6)

      const removedHash = sessionHash()
      const removedProduct = await insertProduct('1300')
      const keptProduct = await insertProduct('1400')
      await addAccountCartItem(database, user, {
        productId: removedProduct,
        quantity: 1,
      })
      await addGuestCartItem(database, removedHash, {
        productId: keptProduct,
        quantity: 1,
      })
      const account = await accountQuantities(user)
      const removed = account.rows.find(
        (row) => row.product_id === removedProduct,
      )

      await finishInOrder({
        lockSql: 'SELECT id FROM public.cart_items WHERE id = $1 FOR UPDATE',
        lockParams: [removed.id],
        first: () => deleteAccountCartItem(database, user, removed.id),
        firstNamespace: ACCOUNT_CART_LOCK_NAMESPACE,
        firstKey: accountCartLockKey(user),
        second: () => mergeGuestCart(database, user, removedHash),
        secondNamespace: ACCOUNT_CART_LOCK_NAMESPACE,
        secondKey: accountCartLockKey(user),
      })

      const after = await accountQuantities(user)

      assert.equal(
        after.rows.some((row) => row.product_id === removedProduct),
        false,
      )
      assert.equal(
        after.rows.find((row) => row.product_id === keptProduct).quantity,
        1,
      )
    },
  )

  it(
    'merges the account quantity written by a waiting patch',
    { skip },
    async () => {
      const user = await insertUser()
      const hash = sessionHash()
      const product = await insertProduct('1000')
      await addAccountCartItem(database, user, {
        productId: product,
        quantity: 1,
      })
      await addGuestCartItem(database, hash, {
        productId: product,
        quantity: 1,
      })
      const stored = await accountQuantities(user)

      await finishInOrder({
        lockSql: 'SELECT id FROM public.carts WHERE user_id = $1 FOR UPDATE',
        lockParams: [user],
        first: () =>
          updateAccountCartItem(database, user, {
            itemId: stored.rows[0].id,
            quantity: 8,
          }),
        firstNamespace: ACCOUNT_CART_LOCK_NAMESPACE,
        firstKey: accountCartLockKey(user),
        second: () => mergeGuestCart(database, user, hash),
        secondNamespace: ACCOUNT_CART_LOCK_NAMESPACE,
        secondKey: accountCartLockKey(user),
      })

      assert.equal((await accountQuantities(user)).rows[0].quantity, 9)
      assert.equal((await quantities(hash)).carts, 0)
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

async function waitFor(read) {
  const deadline = Date.now() + 5000

  while (Date.now() < deadline) {
    if (await read()) {
      return
    }

    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }

  throw new Error('The database lock was not observed')
}

async function withHeldLock(namespace, key, { run, unchanged, changed }) {
  const holder = new pg.Client({ connectionString: databaseUrl })
  await holder.connect()
  let finished = false

  try {
    await holder.query('BEGIN')
    await holder.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [namespace, key],
    )
    const pending = run().finally(() => {
      finished = true
    })
    await waitFor(async () => {
      const waiting = await holder.query(
        `
          SELECT 1
          FROM pg_stat_activity AS a
          JOIN pg_locks AS l ON l.pid = a.pid
          WHERE a.pid <> pg_backend_pid()
            AND a.wait_event_type = 'Lock'
            AND l.locktype = 'advisory'
            AND NOT l.granted
            AND l.classid = $1::oid
            AND l.objid = $2::oid
        `,
        [namespace, String(key >>> 0)],
      )
      return waiting.rowCount > 0
    })
    assert.equal(finished, false)
    await unchanged()
    await holder.query('COMMIT')
    await pending
    await changed()
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    await holder.end()
  }
}

async function whileBlockedOnRow(namespace, key, lockSql, lockParams, run) {
  const holder = new pg.Client({ connectionString: databaseUrl })
  const rival = new pg.Client({ connectionString: databaseUrl })
  await holder.connect()
  await rival.connect()
  let finished = false

  try {
    await holder.query('BEGIN')
    await holder.query(lockSql, lockParams)
    const pending = run().finally(() => {
      finished = true
    })
    await waitFor(async () => {
      const waiting = await holder.query(
        `
          SELECT 1
          FROM pg_stat_activity AS a
          JOIN pg_locks AS l ON l.pid = a.pid
          WHERE a.pid <> pg_backend_pid()
            AND a.wait_event_type = 'Lock'
            AND l.locktype = 'advisory'
            AND l.granted
            AND l.classid = $1::oid
        `,
        [namespace],
      )
      return waiting.rowCount > 0
    })
    assert.equal(finished, false)
    await rival.query('BEGIN')
    const rivalLock = rival.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [namespace, key],
    )
    await waitFor(async () => {
      const waiting = await holder.query(
        `
          SELECT 1
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND NOT granted
            AND classid = $1::oid
            AND objid = $2::oid
        `,
        [namespace, String(key >>> 0)],
      )
      return waiting.rowCount > 0
    })
    await holder.query('COMMIT')
    await pending
    await rivalLock
    await rival.query('COMMIT')
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    await rival.query('ROLLBACK').catch(() => {})
    await holder.end()
    await rival.end()
  }
}

async function waitForUnGranted(holder, namespace, key, count) {
  await waitFor(async () => {
    const waiting = await holder.query(
      `
        SELECT count(*)::int AS total
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND classid = $1::oid
          AND objid = $2::oid
      `,
      [namespace, String(key >>> 0)],
    )
    return waiting.rows[0].total >= count
  })
}

async function finishInOrder({
  lockSql,
  lockParams,
  first,
  firstNamespace,
  firstKey,
  second,
  secondNamespace,
  secondKey,
}) {
  const holder = new pg.Client({ connectionString: databaseUrl })
  await holder.connect()
  const pending = []
  let firstDone = false

  try {
    await holder.query('BEGIN')
    await holder.query(lockSql, lockParams)
    pending.push(
      first().finally(() => {
        firstDone = true
      }),
    )
    await waitFor(async () => {
      const waiting = await holder.query(
        `
          SELECT 1
          FROM pg_stat_activity AS a
          JOIN pg_locks AS l ON l.pid = a.pid
          WHERE a.pid <> pg_backend_pid()
            AND a.wait_event_type = 'Lock'
            AND l.locktype = 'advisory'
            AND l.granted
            AND l.classid = $1::oid
            AND l.objid = $2::oid
        `,
        [firstNamespace, String(firstKey >>> 0)],
      )
      return waiting.rowCount > 0
    })
    assert.equal(firstDone, false)
    pending.push(second())
    await waitForUnGranted(holder, secondNamespace, secondKey, 1)
    await holder.query('COMMIT')
    await Promise.all(pending)
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    await holder.end()
    await Promise.allSettled(pending)
  }
}
