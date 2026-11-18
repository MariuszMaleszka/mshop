import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addGuestCartItem } from '../src/cart/repository.js'
import { registerCartRoutes } from '../src/cart/routes.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
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

function appWith(database, lines = []) {
  const logger = createLogger({
    nodeEnv: 'development',
    write(_level, line) {
      lines.push(line)
    },
  })

  return createApp(config, {
    logger,
    database,
    registerRoutes(router) {
      registerCartRoutes(router, { database })
    },
  })
}

async function request(app, path, { method = 'GET', cookie, body } = {}) {
  const { server, baseUrl } = await listen(app)

  try {
    const headers = {}

    if (cookie !== undefined) {
      headers.cookie = cookie
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

    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data.items, [])
    assert.equal(result.body.data.total_amount, 0)
    assert.deepEqual(database.calls[0].params, [itemId, sessionHash])
    assert.match(database.calls[0].sql, /c\.session_id = \$2/)
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

    assert.equal(result.status, 404)
    assert.equal(database.calls.length, 1)
    assert.deepEqual(database.calls[0].params, [otherItemId, sessionHash])
    assert.match(database.calls[0].sql, /c\.user_id IS NULL/)
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
