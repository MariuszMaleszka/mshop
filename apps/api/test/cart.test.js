import assert from 'node:assert/strict'
import net from 'node:net'
import { describe, it } from 'node:test'
import {
  ACCOUNT_CART_LOCK_NAMESPACE,
  GUEST_CART_LOCK_NAMESPACE,
  accountCartLockKey,
  addGuestCartItem,
  guestCartLockKey,
} from '../src/cart/repository.js'
import { registerCartRoutes } from '../src/cart/routes.js'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { loadConfig } from '../src/config.js'
import { HttpError } from '../src/http/errors.js'
import { createLogger } from '../src/http/logger.js'
import { hashGuestSessionId } from '../src/session/guest-session.js'

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const sessionId = 'ab'.repeat(32)
const otherSessionId = 'cd'.repeat(32)
const sessionHash = hashGuestSessionId(sessionId)
const otherHash = hashGuestSessionId(otherSessionId)
const productId = '44444444-4444-4444-8444-444444444444'
const itemId = '66666666-6666-4666-8666-666666666666'
const otherItemId = '77777777-7777-4777-8777-777777777777'
const userId = '11111111-1111-4111-8111-111111111111'
const otherUserId = '22222222-2222-4222-8222-222222222222'
const accountToken = 'account-token'
const otherAccountToken = 'other-account-token'

const cartId = '88888888-8888-4888-8888-888888888888'

function fakeDatabase(query) {
  const calls = []
  const database = {
    calls,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      calls.push({ sql, params })
      return query(sql, params)
    },
  }

  database.withTransaction = async (work) => {
    calls.push({ sql: 'BEGIN', params: [] })

    try {
      const result = await work(database)
      calls.push({ sql: 'COMMIT', params: [] })
      return result
    } catch (error) {
      calls.push({ sql: 'ROLLBACK', params: [] })
      throw error
    }
  }

  return database
}

function plnCatalog(
  sql,
  { price = '12900', lines = [], cart = [cartLine()] } = {},
) {
  if (
    sql.includes('is_active') &&
    sql.includes('price_amount') &&
    sql.includes('WHERE id')
  ) {
    return {
      rows: [
        {
          id: productId,
          is_active: true,
          currency: 'PLN',
          price_amount: price,
        },
      ],
    }
  }

  if (sql.includes('pg_advisory_xact_lock')) {
    return { rows: [{}] }
  }

  if (sql.startsWith('INSERT INTO public.carts')) {
    return { rows: [] }
  }

  if (sql.includes('FOR UPDATE') && !sql.includes('cart_items')) {
    return { rows: [{ id: cartId }] }
  }

  if (sql.includes('ci.product_id') && !sql.includes('p.name')) {
    return { rows: lines }
  }

  if (sql.startsWith('INSERT INTO public.cart_items')) {
    return { rows: [{ id: itemId }] }
  }

  return { rows: cart }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function appWith(database, lines = [], accessTokens) {
  const logger = createLogger({
    nodeEnv: 'development',
    write(_level, line) {
      lines.push(line)
    },
  })

  return createApp(config, {
    logger,
    database,
    accessTokens,
    registerRoutes(router) {
      registerCartRoutes(router, { database })
    },
  })
}

function accountTokens(users = { [accountToken]: userId }) {
  return {
    async verifyAccessToken(token) {
      const id = users[token]

      if (typeof id !== 'string') {
        throw new HttpError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          logMessage: 'auth.invalid_token',
        })
      }

      return id
    },
  }
}

async function request(
  app,
  path,
  { method = 'GET', cookie, body, authorization } = {},
) {
  const { server, baseUrl } = await listen(app)

  try {
    const headers = {}

    if (cookie !== undefined) {
      headers.cookie = cookie
    }

    if (authorization !== undefined) {
      headers.authorization = authorization
    }

    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()

    return {
      status: response.status,
      text,
      body: JSON.parse(text),
      setCookie: response.headers.getSetCookie(),
    }
  } finally {
    await close(server)
  }
}

function guestCookie(id = sessionId) {
  return `theme=light; shop_guest_session=${id}`
}

function cartLine(id = itemId, product = productId) {
  return {
    id,
    product_id: product,
    name: 'Session',
    price_amount: '12900',
    currency: 'PLN',
    quantity: 2,
  }
}

describe('guest cart reads', () => {
  it('rejects a request without a guest cookie', async () => {
    const lines = []
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(appWith(database, lines), '/api/v1/cart')

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
    assert.equal(result.setCookie.length, 0)
    assert.equal(lines.join('\n').includes('cart.missing_session'), true)
  })

  it('rejects an invalid guest cookie without creating a session', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(appWith(database), '/api/v1/cart', {
      cookie: 'shop_guest_session=NOT-A-VALID-SESSION',
    })

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
    assert.equal(result.setCookie.length, 0)
    assert.equal(result.text.includes('NOT-A-VALID-SESSION'), false)
  })

  it('returns an empty cart when the session has no cart row', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const result = await request(appWith(database), '/api/v1/cart', {
      cookie: guestCookie(),
    })

    assert.equal(result.status, 200)
    assert.deepEqual(result.body, {
      data: { currency: 'PLN', items: [], total_amount: 0 },
      meta: {},
    })
    assert.equal(database.calls.length, 1)
    assert.equal(database.calls[0].sql.includes('INSERT'), false)
    assert.equal(database.calls[0].params[0], sessionHash)
    assert.equal(database.calls[0].sql.includes(sessionId), false)
    assert.equal(database.calls[0].sql.includes(sessionHash), false)
    assert.equal(result.text.includes(sessionId), false)
    assert.equal(result.text.includes(sessionHash), false)
  })

  it('returns only the cart of the current guest session', async () => {
    const database = fakeDatabase(async (_sql, params) => {
      if (params[0] === sessionHash) {
        return { rows: [cartLine()] }
      }

      return { rows: [cartLine(otherItemId, productId)] }
    })
    const own = await request(appWith(database), '/api/v1/cart', {
      cookie: guestCookie(),
    })
    const other = await request(appWith(database), '/api/v1/cart', {
      cookie: guestCookie(otherSessionId),
    })

    assert.equal(own.body.data.items[0].id, itemId)
    assert.equal(own.body.data.items[0].line_amount, 25800)
    assert.equal(own.body.data.total_amount, 25800)
    assert.equal(other.body.data.items[0].id, otherItemId)
    assert.equal(
      own.body.data.items.some((item) => item.id === otherItemId),
      false,
    )
    assert.equal(database.calls[0].params[0], sessionHash)
    assert.equal(database.calls[1].params[0], otherHash)
    assert.equal(own.text.includes(sessionHash), false)
    assert.equal(other.text.includes(otherSessionId), false)
    assert.match(database.calls[0].sql, /c\.user_id IS NULL/)
    assert.match(database.calls[0].sql, /c\.status = 'active'/)
  })
})

describe('POST /api/v1/cart/items', () => {
  it('adds an active product and prices the line from the catalog', async () => {
    const database = fakeDatabase(async (sql) => plnCatalog(sql))
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: {
        productId,
        quantity: 2,
        price_amount: 1,
        currency: 'EUR',
        session_id: sessionId,
        user_id: productId,
      },
    })
    const cartInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.carts'),
    )
    const itemInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.cart_items'),
    )

    assert.equal(result.status, 200)
    assert.equal(result.body.data.items[0].price_amount, 12900)
    assert.equal(result.body.data.items[0].currency, 'PLN')
    assert.equal(result.body.data.total_amount, 25800)
    assert.deepEqual(cartInsert.params, [sessionHash])
    assert.deepEqual(itemInsert.params, [cartId, productId, 2])
    assert.equal(itemInsert.params.includes(1), false)
    assert.equal(cartInsert.sql.includes(sessionId), false)
    assert.match(cartInsert.sql, /ON CONFLICT \(session_id\)/)
    assert.match(cartInsert.sql, /DO NOTHING/)
    assert.match(
      cartInsert.sql,
      /WHERE status = 'active' AND session_id IS NOT NULL/,
    )
    assert.equal(/DO UPDATE/.test(cartInsert.sql), false)
    assert.match(itemInsert.sql, /ON CONFLICT \(cart_id, product_id\)/)
    assert.match(itemInsert.sql, /cart_items\.quantity \+ EXCLUDED\.quantity/)
    assert.ok(
      database.calls.some(
        (call) => call.sql.includes('FOR UPDATE') && !call.sql.includes('OF c'),
      ),
    )
    assert.equal(result.text.includes(sessionId), false)
    assert.equal(result.text.includes(sessionHash), false)
  })

  it('adds another quantity of a product already in the cart', async () => {
    const database = fakeDatabase(async (sql) =>
      plnCatalog(sql, {
        lines: [
          {
            product_id: productId,
            quantity: 1,
            price_amount: '12900',
            currency: 'PLN',
          },
        ],
      }),
    )
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId, quantity: 1 },
    })
    const itemInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.cart_items'),
    )

    assert.equal(result.status, 200)
    assert.match(
      itemInsert.sql,
      /DO UPDATE SET quantity = cart_items\.quantity \+ EXCLUDED\.quantity/,
    )
    assert.equal(result.body.data.items[0].quantity, 2)
  })

  it('returns 404 when the product does not exist', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId, quantity: 1 },
    })

    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'NOT_FOUND')
    assert.equal(
      database.calls.some((call) =>
        call.sql.includes('INSERT INTO public.carts'),
      ),
      false,
    )
  })

  it('returns 404 when the product is inactive', async () => {
    const database = fakeDatabase(async () => ({
      rows: [
        {
          id: productId,
          is_active: false,
          currency: 'PLN',
          price_amount: '12900',
        },
      ],
    }))
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId, quantity: 1 },
    })

    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'NOT_FOUND')
    assert.equal(result.text.includes('inactive'), false)
    assert.equal(
      database.calls.some((call) =>
        call.sql.includes('INSERT INTO public.carts'),
      ),
      false,
    )
  })

  it('rejects a product id that is not a UUID before querying', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId: 'not-a-uuid', quantity: 1 },
    })

    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'VALIDATION_ERROR')
    assert.equal(database.calls.length, 0)
    assert.equal(result.text.includes('not-a-uuid'), false)
  })

  it('rejects zero, negative, fractional and oversized quantities', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })

    for (const quantity of [0, -1, 1.5, 2147483648, '2']) {
      const result = await request(appWith(database), '/api/v1/cart/items', {
        method: 'POST',
        cookie: guestCookie(),
        body: { productId, quantity },
      })

      assert.equal(result.status, 400)
      assert.equal(result.body.error.code, 'VALIDATION_ERROR')
    }

    assert.equal(database.calls.length, 0)
  })

  it('rejects a quantity that would overflow the integer column', async () => {
    const database = fakeDatabase(async (sql) =>
      plnCatalog(sql, {
        price: '1',
        lines: [
          {
            product_id: productId,
            quantity: 2147483647,
            price_amount: '1',
            currency: 'PLN',
          },
        ],
        cart: [],
      }),
    )
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId, quantity: 1 },
    })

    assert.equal(result.status, 400)
    assert.equal(result.body.error.details[0].path, 'quantity')
    assert.equal(result.text.includes(sessionHash), false)
    assert.equal(
      database.calls.some((call) =>
        call.sql.startsWith('INSERT INTO public.cart_items'),
      ),
      false,
    )
  })

  it('rejects an amount that exceeds the safe integer range before writing the line', async () => {
    const database = fakeDatabase(async (sql) =>
      plnCatalog(sql, { price: '5000000000000000', cart: [] }),
    )
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId, quantity: 2 },
    })

    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'VALIDATION_ERROR')
    assert.equal(result.body.error.details[0].path, 'total_amount')
    assert.equal(result.text.includes('5000000000000000'), false)
    assert.equal(
      database.calls.some((call) =>
        call.sql.startsWith('INSERT INTO public.cart_items'),
      ),
      false,
    )
    assert.equal(
      database.calls.some((call) => call.sql === 'ROLLBACK'),
      true,
    )
  })

  it('rejects a cart total that would exceed the safe integer range', async () => {
    const database = fakeDatabase(async (sql) =>
      plnCatalog(sql, {
        price: '1',
        lines: [
          {
            product_id: otherItemId,
            quantity: 1,
            price_amount: '9007199254740991',
            currency: 'PLN',
          },
        ],
        cart: [],
      }),
    )
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId, quantity: 1 },
    })

    assert.equal(result.status, 400)
    assert.equal(result.body.error.details[0].path, 'total_amount')
    assert.equal(
      database.calls.some((call) =>
        call.sql.startsWith('INSERT INTO public.cart_items'),
      ),
      false,
    )
    assert.equal(
      database.calls.some((call) => call.sql === 'ROLLBACK'),
      true,
    )
  })

  it('returns a domain error when a stored line no longer fits the response contract', async () => {
    const database = fakeDatabase(async () => ({
      rows: [
        {
          ...cartLine(),
          price_amount: '9007199254740991',
          quantity: 2,
        },
      ],
    }))
    const result = await request(appWith(database), '/api/v1/cart', {
      cookie: guestCookie(),
    })

    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'VALIDATION_ERROR')
    assert.equal(result.body.error.details[0].path, 'total_amount')
    assert.equal(result.text.includes('9007199254740991'), false)
  })

  it('rejects a product whose currency is not PLN', async () => {
    const database = fakeDatabase(async () => ({
      rows: [
        {
          id: productId,
          is_active: true,
          currency: 'EUR',
          price_amount: '12900',
        },
      ],
    }))
    const result = await request(appWith(database), '/api/v1/cart/items', {
      method: 'POST',
      cookie: guestCookie(),
      body: { productId, quantity: 1, currency: 'EUR', price_amount: 1 },
    })

    assert.equal(result.status, 400)
    assert.equal(result.body.error.details[0].path, 'currency')
    assert.equal(result.text.includes('EUR'), false)
    assert.equal(
      database.calls.some((call) =>
        call.sql.includes('INSERT INTO public.carts'),
      ),
      false,
    )
    assert.equal(
      database.calls.some((call) => call.params.includes(1)),
      false,
    )
  })

  it('locks the cart after the conflict insert instead of reading one snapshot', async () => {
    const database = fakeDatabase(async (sql) => plnCatalog(sql))

    await addGuestCartItem(database, sessionHash, { productId, quantity: 1 })

    const cartInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.carts'),
    )
    const lock = database.calls.find(
      (call) => call.sql.includes('FOR UPDATE') && !call.sql.includes('OF c'),
    )
    const itemInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.cart_items'),
    )

    assert.ok(cartInsert)
    assert.match(cartInsert.sql, /DO NOTHING/)
    assert.ok(lock)
    assert.ok(database.calls.indexOf(lock) > database.calls.indexOf(cartInsert))
    assert.match(itemInsert.sql, /ON CONFLICT \(cart_id, product_id\)/)
    assert.equal(database.calls.at(-1).sql, 'COMMIT')
  })
})

describe('PATCH and DELETE /api/v1/cart/items/:id', () => {
  it('updates a line owned by the current session', async () => {
    const database = fakeDatabase(async (sql) => {
      if (sql.includes('FOR UPDATE OF c')) {
        return { rows: [{ cart_id: cartId, product_id: productId }] }
      }

      if (sql.includes('ci.product_id') && !sql.includes('p.name')) {
        return {
          rows: [
            {
              product_id: productId,
              quantity: 2,
              price_amount: '12900',
              currency: 'PLN',
            },
          ],
        }
      }

      if (sql.startsWith('UPDATE')) {
        return { rows: [{ id: itemId }] }
      }

      return { rows: [{ ...cartLine(), quantity: 3 }] }
    })
    const result = await request(
      appWith(database),
      `/api/v1/cart/items/${itemId}`,
      {
        method: 'PATCH',
        cookie: guestCookie(),
        body: { quantity: 3, price_amount: 1, currency: 'EUR' },
      },
    )

    const update = database.calls.find((call) => call.sql.startsWith('UPDATE'))

    assert.equal(result.status, 200)
    assert.equal(result.body.data.items[0].quantity, 3)
    assert.equal(result.body.data.items[0].price_amount, 12900)
    assert.deepEqual(update.params, [itemId, sessionHash, 3])
    assert.match(update.sql, /c\.session_id = \$2/)
    assert.equal(update.sql.includes(sessionId), false)
  })

  it('does not update a line owned by another guest', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const result = await request(
      appWith(database),
      `/api/v1/cart/items/${otherItemId}`,
      {
        method: 'PATCH',
        cookie: guestCookie(),
        body: { quantity: 4 },
      },
    )

    const lock = database.calls.find((call) => call.sql.includes('FOR UPDATE'))

    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'NOT_FOUND')
    assert.deepEqual(lock.params, [otherItemId, sessionHash])
    assert.equal(
      database.calls.some((call) => call.sql.startsWith('UPDATE')),
      false,
    )
  })

  it('deletes a line owned by the current session', async () => {
    const database = fakeDatabase(async (sql) => {
      if (sql.startsWith('DELETE')) {
        return { rows: [{ id: itemId }] }
      }

      return { rows: [] }
    })
    const result = await request(
      appWith(database),
      `/api/v1/cart/items/${itemId}`,
      {
        method: 'DELETE',
        cookie: guestCookie(),
      },
    )

    const removed = database.calls.find((call) => call.sql.startsWith('DELETE'))

    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data.items, [])
    assert.equal(result.body.data.total_amount, 0)
    assert.deepEqual(removed.params, [itemId, sessionHash])
    assert.match(removed.sql, /c\.session_id = \$2/)
  })

  it('does not delete a line owned by another guest', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const result = await request(
      appWith(database),
      `/api/v1/cart/items/${otherItemId}`,
      {
        method: 'DELETE',
        cookie: guestCookie(),
      },
    )
    const removed = database.calls.find((call) => call.sql.startsWith('DELETE'))

    assert.equal(result.status, 404)
    assert.deepEqual(removed.params, [otherItemId, sessionHash])
    assert.match(removed.sql, /c\.user_id IS NULL/)
  })
})

describe('guest cart database errors', () => {
  it('hides a database failure and the session hash', async () => {
    const lines = []
    const database = fakeDatabase(async () => {
      throw new Error(`password=secret public.carts ${sessionHash}`)
    })
    const result = await request(appWith(database, lines), '/api/v1/cart', {
      cookie: guestCookie(),
    })
    const logged = lines.join('\n')

    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE')
    assert.equal(result.text.includes(sessionHash), false)
    assert.equal(result.text.includes(sessionId), false)
    assert.equal(result.text.includes('password'), false)
    assert.equal(result.text.includes('carts'), false)
    assert.equal(logged.includes(sessionHash), false)
    assert.equal(logged.includes(sessionId), false)
    assert.equal(logged.includes('password'), false)
    assert.equal(logged.includes('cart.query_failed'), true)
  })
})

describe('account cart access', () => {
  it('keeps the guest cart when the request has no authorization header', async () => {
    const database = fakeDatabase(async () => ({ rows: [cartLine()] }))
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart',
      { cookie: guestCookie() },
    )

    assert.equal(result.status, 200)
    assert.equal(result.body.data.items[0].id, itemId)
    assert.deepEqual(database.calls[0].params, [sessionHash])
    assert.match(database.calls[0].sql, /c\.session_id = \$1/)
    assert.match(database.calls[0].sql, /c\.user_id IS NULL/)
  })

  it('rejects a guest request that has neither a header nor a cookie', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart',
    )

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
  })

  it('reads the account cart from the verified user when no cookie is sent', async () => {
    const database = fakeDatabase(async (_sql, params) => {
      if (params[0] === userId) {
        return { rows: [cartLine()] }
      }

      return { rows: [cartLine(otherItemId)] }
    })
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart',
      { authorization: `Bearer ${accountToken}` },
    )

    assert.equal(result.status, 200)
    assert.equal(result.body.data.items[0].id, itemId)
    assert.deepEqual(database.calls[0].params, [userId])
    assert.match(database.calls[0].sql, /c\.user_id = \$1::uuid/)
    assert.match(database.calls[0].sql, /c\.session_id IS NULL/)
    assert.match(database.calls[0].sql, /c\.status = 'active'/)
    assert.equal(database.calls[0].params.includes(sessionHash), false)
  })

  it('ignores a valid guest cookie when the bearer token is valid', async () => {
    const database = fakeDatabase(async (sql) => plnCatalog(sql))
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/items',
      {
        method: 'POST',
        cookie: guestCookie(),
        authorization: `Bearer ${accountToken}`,
        body: { productId, quantity: 1, user_id: otherUserId },
      },
    )
    const cartInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.carts'),
    )

    assert.equal(result.status, 200)
    assert.deepEqual(cartInsert.params, [userId])
    assert.match(cartInsert.sql, /ON CONFLICT \(user_id\)/)
    assert.match(cartInsert.sql, /DO NOTHING/)
    assert.equal(/DO UPDATE/.test(cartInsert.sql), false)
    assert.equal(
      database.calls.some((call) =>
        call.params.some(
          (param) => param === sessionHash || param === otherUserId,
        ),
      ),
      false,
    )
  })

  it('does not fall back to the guest cart when the token is rejected', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart',
      {
        cookie: guestCookie(),
        authorization: 'Bearer rejected-token',
      },
    )

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
    assert.equal(result.text.includes(sessionId), false)
  })

  it('rejects an empty or malformed authorization header', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const app = appWith(database, [], accountTokens())

    for (const authorization of ['Bearer', 'Bearer ', 'Token secret']) {
      const result = await request(app, '/api/v1/cart', {
        cookie: guestCookie(),
        authorization,
      })

      assert.equal(result.status, 401)
      assert.equal(result.body.error.code, 'UNAUTHORIZED')
    }

    assert.equal(database.calls.length, 0)
  })

  it('accepts a mixed-case authorization header for the account cart', async () => {
    const database = fakeDatabase(async () => ({ rows: [cartLine()] }))
    const app = appWith(database, [], accountTokens())
    const result = await rawRequest(
      app,
      `AuThOrIzAtIoN: Bearer ${accountToken}`,
    )

    assert.equal(result.status, 200)
    assert.deepEqual(database.calls[0].params, [userId])
    assert.match(database.calls[0].sql, /c\.user_id = \$1::uuid/)
    assert.equal(database.calls[0].params.includes(sessionHash), false)
  })
})

describe('account cart isolation', () => {
  it('does not return another user cart', async () => {
    const database = fakeDatabase(async (_sql, params) => {
      if (params[0] === otherUserId) {
        return { rows: [cartLine(otherItemId)] }
      }

      return { rows: [] }
    })
    const tokens = accountTokens({
      [accountToken]: userId,
      [otherAccountToken]: otherUserId,
    })
    const own = await request(appWith(database, [], tokens), '/api/v1/cart', {
      authorization: `Bearer ${accountToken}`,
      cookie: guestCookie(),
    })
    const other = await request(appWith(database, [], tokens), '/api/v1/cart', {
      authorization: `Bearer ${otherAccountToken}`,
    })

    assert.deepEqual(own.body.data.items, [])
    assert.equal(other.body.data.items[0].id, otherItemId)
    assert.deepEqual(database.calls[0].params, [userId])
    assert.deepEqual(database.calls[1].params, [otherUserId])
    assert.equal(
      database.calls.some((call) => call.params.includes(sessionHash)),
      false,
    )
  })

  it('does not update or delete another user line', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const app = appWith(database, [], accountTokens())
    const patched = await request(app, `/api/v1/cart/items/${otherItemId}`, {
      method: 'PATCH',
      authorization: `Bearer ${accountToken}`,
      cookie: guestCookie(),
      body: { quantity: 4, user_id: otherUserId },
    })
    const removed = await request(app, `/api/v1/cart/items/${otherItemId}`, {
      method: 'DELETE',
      authorization: `Bearer ${accountToken}`,
      cookie: guestCookie(),
    })
    const update = database.calls.find((call) => call.sql.startsWith('UPDATE'))
    const lock = database.calls.find((call) => call.sql.includes('FOR UPDATE'))
    const deleted = database.calls.find((call) => call.sql.startsWith('DELETE'))

    assert.equal(patched.status, 404)
    assert.equal(removed.status, 404)
    assert.equal(update, undefined)
    assert.deepEqual(lock.params, [otherItemId, userId])
    assert.match(lock.sql, /c\.user_id = \$2::uuid/)
    assert.match(lock.sql, /c\.session_id IS NULL/)
    assert.deepEqual(deleted.params, [otherItemId, userId])
    assert.equal(deleted.params.includes(sessionHash), false)
    assert.equal(deleted.params.includes(otherUserId), false)
  })

  it('prices an account line from the catalog and stores only the token user', async () => {
    const database = fakeDatabase(async (sql) => plnCatalog(sql))
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/items',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        body: {
          productId,
          quantity: 2,
          price_amount: 1,
          currency: 'EUR',
          user_id: otherUserId,
          session_id: sessionId,
        },
      },
    )
    const cartInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.carts'),
    )
    const lock = database.calls.find(
      (call) => call.sql.includes('FOR UPDATE') && !call.sql.includes('OF c'),
    )
    const itemInsert = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.cart_items'),
    )

    assert.equal(result.status, 200)
    assert.equal(result.body.data.items[0].price_amount, 12900)
    assert.equal(result.body.data.items[0].currency, 'PLN')
    assert.deepEqual(cartInsert.params, [userId])
    assert.deepEqual(lock.params, [userId])
    assert.deepEqual(itemInsert.params, [cartId, productId, 2])
    assert.match(itemInsert.sql, /cart_items\.quantity \+ EXCLUDED\.quantity/)
    assert.equal(
      database.calls.indexOf(lock) > database.calls.indexOf(cartInsert),
      true,
    )
    assert.equal(
      database.calls.some((call) =>
        call.params.some(
          (param) =>
            param === otherUserId || param === sessionHash || param === 1,
        ),
      ),
      false,
    )
  })

  it('returns 404 for a missing or inactive account product', async () => {
    const missing = fakeDatabase(async () => ({ rows: [] }))
    const inactive = fakeDatabase(async () => ({
      rows: [
        {
          id: productId,
          is_active: false,
          currency: 'PLN',
          price_amount: '12900',
        },
      ],
    }))
    const missingResult = await request(
      appWith(missing, [], accountTokens()),
      '/api/v1/cart/items',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        body: { productId, quantity: 1 },
      },
    )
    const inactiveResult = await request(
      appWith(inactive, [], accountTokens()),
      '/api/v1/cart/items',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        body: { productId, quantity: 1 },
      },
    )

    assert.equal(missingResult.status, 404)
    assert.equal(inactiveResult.status, 404)
    assert.equal(
      missing.calls.some((call) =>
        call.sql.includes('INSERT INTO public.carts'),
      ),
      false,
    )
    assert.equal(
      inactive.calls.some((call) =>
        call.sql.includes('INSERT INTO public.carts'),
      ),
      false,
    )
  })

  it('rejects a non-PLN product for the account cart', async () => {
    const database = fakeDatabase(async () => ({
      rows: [
        {
          id: productId,
          is_active: true,
          currency: 'EUR',
          price_amount: '12900',
        },
      ],
    }))
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/items',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        body: { productId, quantity: 1 },
      },
    )

    assert.equal(result.status, 400)
    assert.equal(result.body.error.details[0].path, 'currency')
    assert.equal(
      database.calls.some((call) =>
        call.sql.includes('INSERT INTO public.carts'),
      ),
      false,
    )
  })

  it('rolls back an account amount outside the safe integer range', async () => {
    const database = fakeDatabase(async (sql) =>
      plnCatalog(sql, { price: '5000000000000000', cart: [] }),
    )
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/items',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        body: { productId, quantity: 2 },
      },
    )

    assert.equal(result.status, 400)
    assert.equal(result.body.error.details[0].path, 'total_amount')
    assert.equal(
      database.calls.some((call) =>
        call.sql.startsWith('INSERT INTO public.cart_items'),
      ),
      false,
    )
    assert.equal(
      database.calls.some((call) => call.sql === 'ROLLBACK'),
      true,
    )
    assert.equal(database.calls.at(-1).sql, 'ROLLBACK')
  })

  it('rejects an account quantity that would overflow the integer column', async () => {
    const database = fakeDatabase(async (sql) =>
      plnCatalog(sql, {
        price: '1',
        lines: [
          {
            product_id: productId,
            quantity: 2147483647,
            price_amount: '1',
            currency: 'PLN',
          },
        ],
        cart: [],
      }),
    )
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/items',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        body: { productId, quantity: 1 },
      },
    )

    assert.equal(result.status, 400)
    assert.equal(result.body.error.details[0].path, 'quantity')
    assert.equal(
      database.calls.some((call) =>
        call.sql.startsWith('INSERT INTO public.cart_items'),
      ),
      false,
    )
    assert.equal(
      database.calls.some((call) => call.sql === 'COMMIT'),
      true,
    )
  })
})

describe('cart owner locks', () => {
  it('derives signed int32 keys for a guest hash and an account id', () => {
    assert.equal(guestCartLockKey(`00000000${'ab'.repeat(28)}`), 0)
    assert.equal(guestCartLockKey(`80000000${'ab'.repeat(28)}`), -2147483648)
    assert.equal(guestCartLockKey(`7fffffff${'ab'.repeat(28)}`), 2147483647)
    assert.equal(guestCartLockKey(`ffffffff${'ab'.repeat(28)}`), -1)
    assert.equal(
      accountCartLockKey(userId),
      guestCartLockKey(userId.replaceAll('-', '')),
    )
    assert.equal(GUEST_CART_LOCK_NAMESPACE, 71001)
    assert.equal(ACCOUNT_CART_LOCK_NAMESPACE, 71002)
  })

  it('locks the guest before inserting and keeps the hash out of that statement', async () => {
    const database = fakeDatabase(async (sql) => plnCatalog(sql))

    await addGuestCartItem(database, sessionHash, { productId, quantity: 1 })

    const lock = database.calls.find((call) =>
      call.sql.includes('pg_advisory_xact_lock'),
    )
    const inserted = database.calls.find((call) =>
      call.sql.startsWith('INSERT INTO public.carts'),
    )

    assert.deepEqual(lock.params, [71001, guestCartLockKey(sessionHash)])
    assert.equal(lock.sql.includes(sessionHash), false)
    assert.equal(lock.sql.includes(sessionId), false)
    assert.equal(
      database.calls.indexOf(lock) < database.calls.indexOf(inserted),
      true,
    )
    assert.equal(database.calls.at(-1).sql, 'COMMIT')
  })

  it('rolls back and releases the client when the cart write fails', async () => {
    let released = 0
    const queries = []
    const database = createDatabase({
      connectionString:
        'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      createPool() {
        return {
          on() {},
          async connect() {
            return {
              async query(sql) {
                queries.push(sql)
                if (sql === 'BEGIN' || sql === 'ROLLBACK') {
                  return { rows: [] }
                }

                if (sql.includes('pg_advisory_xact_lock')) {
                  return { rows: [{}] }
                }

                if (sql.includes('FROM public.products')) {
                  return {
                    rows: [
                      {
                        id: productId,
                        is_active: true,
                        currency: 'PLN',
                        price_amount: '10',
                      },
                    ],
                  }
                }

                throw new Error('insert failed')
              },
              release() {
                released += 1
              },
            }
          },
          async end() {},
        }
      },
    })

    await assert.rejects(
      addGuestCartItem(database, sessionHash, { productId, quantity: 1 }),
      /insert failed/,
    )

    assert.equal(released, 1)
    assert.equal(
      queries.some((sql) => sql.includes('pg_advisory_xact_lock')),
      true,
    )
    assert.equal(
      queries.indexOf('ROLLBACK') >
        queries.findIndex((sql) => sql.includes('pg_advisory_xact_lock')),
      true,
    )
  })
})

const guestCartId = '99999999-9999-4999-8999-999999999999'
const accountCartId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const movedItemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const secondProductId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function mergeLine(id, product, quantity = 1, price = '1000') {
  return {
    id,
    product_id: product,
    quantity,
    price_amount: price,
    currency: 'PLN',
  }
}

function mergeDatabase({
  guestCart = { id: guestCartId, currency: 'PLN' },
  guestLines = [mergeLine(itemId, productId)],
  accountCart = null,
  accountLines = [],
  accountRead = [cartLine(itemId, productId)],
  failUpdate = false,
} = {}) {
  let merged = false

  return fakeDatabase(async (sql, params) => {
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [{}] }
    }

    if (
      sql.includes('FROM public.carts') &&
      sql.includes('session_id = $1') &&
      sql.includes('FOR UPDATE')
    ) {
      return { rows: !merged && guestCart ? [guestCart] : [] }
    }

    if (sql.includes('FROM public.cart_items') && sql.includes('FOR UPDATE')) {
      return {
        rows: params[0] === guestCartId ? guestLines : accountLines,
      }
    }

    if (
      sql.includes('FROM public.carts') &&
      sql.includes('user_id = $1') &&
      sql.includes('FOR UPDATE')
    ) {
      return { rows: accountCart ? [accountCart] : [] }
    }

    if (sql.startsWith('UPDATE public.carts')) {
      if (failUpdate) {
        throw new Error(`update failed ${sessionHash}`)
      }

      merged = true
      return { rows: [{ id: guestCartId }] }
    }

    if (sql.startsWith('INSERT INTO public.cart_items')) {
      return { rows: [{ id: movedItemId }] }
    }

    if (sql.includes('p.name')) {
      return { rows: accountRead }
    }

    return { rows: [] }
  })
}

describe('cart merge', () => {
  it('requires a bearer token', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/merge',
      { method: 'POST', cookie: guestCookie() },
    )

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
  })

  it('rejects an invalid token before reading a cart', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: 'Bearer wrong-token',
        cookie: guestCookie(),
      },
    )

    assert.equal(result.status, 401)
    assert.equal(database.calls.length, 0)
  })

  it('returns 503 when token verification is unavailable', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('database must not be used')
    })
    const result = await request(
      appWith(database, [], {
        async verifyAccessToken() {
          throw new HttpError({
            status: 503,
            code: 'SERVICE_UNAVAILABLE',
            message: 'Service unavailable',
            logMessage: 'auth.jwks_unavailable',
          })
        },
      }),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        cookie: guestCookie(),
      },
    )

    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE')
    assert.equal(database.calls.length, 0)
  })

  it('returns the account cart when the guest cookie is missing, invalid, or duplicated', async () => {
    for (const cookie of [
      undefined,
      'shop_guest_session=short',
      `${guestCookie()}; shop_guest_session=${otherSessionId}`,
    ]) {
      const database = mergeDatabase({
        accountRead: [cartLine()],
      })
      const result = await request(
        appWith(database, [], accountTokens()),
        '/api/v1/cart/merge',
        {
          method: 'POST',
          authorization: `Bearer ${accountToken}`,
          cookie,
          body: { user_id: otherUserId, session_id: sessionId },
        },
      )

      assert.equal(result.status, 200)
      assert.equal(result.body.data.items[0].id, itemId)
      assert.equal(result.setCookie.length, 0)
      assert.equal(
        database.calls.some((call) => call.sql === 'BEGIN'),
        false,
      )
      assert.equal(
        database.calls.some((call) => call.sql.includes(sessionHash)),
        false,
      )
      assert.deepEqual(database.calls.at(-1).params, [userId])
    }
  })

  it('does not create a cart when the guest cart is missing or empty', async () => {
    for (const options of [
      { guestCart: null, accountRead: [] },
      { guestLines: [], accountRead: [] },
    ]) {
      const database = mergeDatabase(options)
      const result = await request(
        appWith(database, [], accountTokens()),
        '/api/v1/cart/merge',
        {
          method: 'POST',
          authorization: `Bearer ${accountToken}`,
          cookie: guestCookie(),
        },
      )

      assert.equal(result.status, 200)
      assert.deepEqual(result.body.data.items, [])
      assert.equal(
        database.calls.some((call) => call.sql.startsWith('INSERT')),
        false,
      )
      assert.equal(
        database.calls.some((call) => call.sql.startsWith('UPDATE')),
        false,
      )
      assert.equal(
        database.calls.some((call) => call.sql === 'COMMIT'),
        true,
      )
    }
  })

  it('transfers a guest cart by changing its owner and keeping the line id', async () => {
    const database = mergeDatabase()
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        cookie: guestCookie(),
        body: { user_id: otherUserId },
      },
    )
    const locks = database.calls.filter((call) =>
      call.sql.includes('pg_advisory_xact_lock'),
    )
    const guestLock = database.calls.find(
      (call) =>
        call.sql.includes('FOR UPDATE') && call.sql.includes('session_id = $1'),
    )
    const accountLock = database.calls.find(
      (call) =>
        call.sql.includes('FOR UPDATE') &&
        call.sql.includes('user_id = $1') &&
        call.sql.includes('FROM public.carts'),
    )
    const adopted = database.calls.find((call) =>
      call.sql.startsWith('UPDATE public.carts'),
    )

    assert.equal(result.status, 200)
    assert.equal(result.setCookie.length, 0)
    assert.deepEqual(locks[0].params, [71001, guestCartLockKey(sessionHash)])
    assert.deepEqual(locks[1].params, [71002, accountCartLockKey(userId)])
    assert.equal(
      database.calls.indexOf(locks[0]) < database.calls.indexOf(locks[1]),
      true,
    )
    assert.equal(
      database.calls.indexOf(locks[1]) < database.calls.indexOf(guestLock),
      true,
    )
    assert.equal(
      database.calls.indexOf(guestLock) < database.calls.indexOf(accountLock),
      true,
    )
    assert.deepEqual(accountLock.params, [userId])
    assert.equal(
      database.calls.indexOf(accountLock) < database.calls.indexOf(adopted),
      true,
    )
    assert.equal(adopted.sql.includes('abandoned'), false)
    assert.equal(adopted.sql.includes(sessionHash), false)
    assert.equal(adopted.sql.includes(userId), false)
    assert.deepEqual(adopted.params, [userId, guestCartId, sessionHash])
    assert.equal(
      database.calls.some((call) => call.sql.startsWith('INSERT')),
      false,
    )
    assert.equal(database.calls.at(-2).sql, 'COMMIT')
  })

  it('sums matching products, moves the others, and abandons the guest cart', async () => {
    const database = mergeDatabase({
      guestLines: [
        mergeLine(itemId, productId, 2),
        mergeLine(movedItemId, secondProductId, 1),
      ],
      accountCart: { id: accountCartId, currency: 'PLN' },
      accountLines: [mergeLine(otherItemId, productId, 3)],
      accountRead: [
        cartLine(otherItemId, productId),
        cartLine(movedItemId, secondProductId),
      ],
    })
    const result = await request(
      appWith(database, [], accountTokens()),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        cookie: guestCookie(),
      },
    )
    const inserted = database.calls.filter((call) =>
      call.sql.startsWith('INSERT INTO public.cart_items'),
    )
    const abandoned = database.calls.find((call) =>
      call.sql.includes('abandoned'),
    )

    assert.equal(result.status, 200)
    assert.equal(result.body.data.items[0].id, otherItemId)
    assert.deepEqual(inserted[0].params, [accountCartId, productId, 2])
    assert.deepEqual(inserted[1].params, [accountCartId, secondProductId, 1])
    assert.deepEqual(abandoned.params, [guestCartId, sessionHash])
    assert.equal(abandoned.sql.includes('user_id = $1::uuid'), false)
    assert.equal(
      database.calls.some((call) => call.sql.includes('is_active')),
      false,
    )
  })

  it('does not copy lines again when the guest cart is no longer active', async () => {
    const database = mergeDatabase({
      accountCart: { id: accountCartId, currency: 'PLN' },
      accountLines: [mergeLine(otherItemId, productId, 1)],
    })
    const app = appWith(database, [], accountTokens())

    await request(app, '/api/v1/cart/merge', {
      method: 'POST',
      authorization: `Bearer ${accountToken}`,
      cookie: guestCookie(),
    })
    const result = await request(app, '/api/v1/cart/merge', {
      method: 'POST',
      authorization: `Bearer ${accountToken}`,
      cookie: guestCookie(),
    })
    const inserts = database.calls.filter((call) =>
      call.sql.startsWith('INSERT INTO public.cart_items'),
    )

    assert.equal(result.status, 200)
    assert.equal(inserts.length, 1)
  })

  it('rolls back when the merged quantity or amount is too large', async () => {
    const quantityDatabase = mergeDatabase({
      guestLines: [mergeLine(itemId, productId, 1)],
      accountCart: { id: accountCartId, currency: 'PLN' },
      accountLines: [mergeLine(otherItemId, productId, 2147483647)],
    })
    const quantity = await request(
      appWith(quantityDatabase, [], accountTokens()),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        cookie: guestCookie(),
      },
    )

    assert.equal(quantity.status, 400)
    assert.equal(quantity.body.error.details[0].path, 'quantity')
    assert.equal(
      quantityDatabase.calls.some((call) => call.sql === 'ROLLBACK'),
      true,
    )
    assert.equal(
      quantityDatabase.calls.some((call) =>
        call.sql.startsWith('INSERT INTO public.cart_items'),
      ),
      false,
    )

    const amountDatabase = mergeDatabase({
      guestLines: [mergeLine(itemId, productId, 2, '9007199254740991')],
    })
    const amount = await request(
      appWith(amountDatabase, [], accountTokens()),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        cookie: guestCookie(),
      },
    )

    assert.equal(amount.status, 400)
    assert.equal(amount.body.error.details[0].path, 'total_amount')
    assert.equal(
      amountDatabase.calls.some((call) => call.sql === 'ROLLBACK'),
      true,
    )
    assert.equal(
      amountDatabase.calls.some((call) => call.sql.startsWith('UPDATE')),
      false,
    )
  })

  it('rolls back a non-PLN cart and a failed write', async () => {
    const currencyDatabase = mergeDatabase({
      guestCart: { id: guestCartId, currency: 'EUR' },
    })
    const currency = await request(
      appWith(currencyDatabase, [], accountTokens()),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        cookie: guestCookie(),
      },
    )

    assert.equal(currency.status, 400)
    assert.equal(currency.body.error.details[0].path, 'currency')
    assert.equal(
      currencyDatabase.calls.some((call) => call.sql === 'ROLLBACK'),
      true,
    )
    assert.equal(
      currencyDatabase.calls.some((call) => call.sql.startsWith('UPDATE')),
      false,
    )

    const lines = []
    const failed = mergeDatabase({ failUpdate: true })
    const result = await request(
      appWith(failed, lines, accountTokens()),
      '/api/v1/cart/merge',
      {
        method: 'POST',
        authorization: `Bearer ${accountToken}`,
        cookie: guestCookie(),
      },
    )

    assert.equal(result.status, 503)
    assert.equal(result.text.includes(sessionHash), false)
    assert.equal(result.text.includes(userId), false)
    assert.equal(lines.join('\n').includes(sessionHash), false)
    assert.equal(
      failed.calls.some((call) => call.sql === 'ROLLBACK'),
      true,
    )
    assert.equal(
      failed.calls.some((call) => call.sql === 'COMMIT'),
      false,
    )
  })
})

function rawRequest(app, headerLine) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end(
          `GET /api/v1/cart HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headerLine}\r\nConnection: close\r\n\r\n`,
        )
      })
      const chunks = []

      socket.on('data', (chunk) => {
        chunks.push(chunk)
      })
      socket.on('error', (error) => {
        server.close()
        reject(error)
      })
      socket.on('end', () => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          const raw = Buffer.concat(chunks).toString('utf8')
          const separator = raw.indexOf('\r\n\r\n')
          const status = Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1])
          resolve({
            status,
            body: JSON.parse(raw.slice(separator + 4)),
          })
        })
      })
    })
  })
}
