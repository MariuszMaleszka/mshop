import assert from 'node:assert/strict'
import net from 'node:net'
import { describe, it } from 'node:test'
import { registerCheckoutRoutes } from '../src/checkout/routes.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { HttpError } from '../src/http/errors.js'
import { createLogger } from '../src/http/logger.js'
import { hashGuestSessionId } from '../src/session/guest-session.js'

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const sessionId = 'ab'.repeat(32)
const sessionHash = hashGuestSessionId(sessionId)
const userId = '11111111-1111-4111-8111-111111111111'
const accountToken = 'account-token'
const cartId = '88888888-8888-4888-8888-888888888888'
const productId = '44444444-4444-4444-8444-444444444444'
const idempotencyKey = 'checkout-key-1'

function fakeDatabase(state = {}) {
  const calls = []
  const database = {
    calls,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      calls.push({ sql, params })

      if (!sql.startsWith('SELECT')) {
        throw new Error(`Unexpected write: ${sql}`)
      }

      if (sql.includes('shop_profile')) {
        return {
          rows: [{ seller_tax_status: state.seller ?? 'registered' }],
        }
      }

      if (sql.includes('FROM public.carts')) {
        if (state.owner !== undefined && params[0] !== state.owner) {
          return { rows: [] }
        }

        return { rows: state.carts ?? [] }
      }

      if (sql.includes('cart_items')) {
        return { rows: state.items ?? [] }
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
    async withTransaction() {
      throw new Error('Checkout must not open a transaction')
    },
  }

  return database
}

function appWith(database) {
  const logger = createLogger({
    nodeEnv: 'development',
    write() {},
  })

  return createApp(config, {
    logger,
    database,
    accessTokens: {
      async verifyAccessToken(token) {
        if (token !== accountToken) {
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
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
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

function billing(overrides = {}) {
  return {
    firstName: 'Anna',
    lastName: 'Nowak',
    street: 'Lipowa',
    buildingNumber: '1',
    postalCode: '00-001',
    city: 'Warszawa',
    countryCode: 'PL',
    ...overrides,
  }
}

function validBody(overrides = {}) {
  return {
    email: 'buyer@example.com',
    customerType: 'individual',
    paymentMethod: 'online',
    billing: billing(),
    ...overrides,
  }
}

async function request(database, options = {}) {
  const cookie = options.cookie
  const authorization = options.authorization
  const body = options.body ?? validBody()
  const idempotency = Object.hasOwn(options, 'idempotency')
    ? options.idempotency
    : idempotencyKey
  const { server, baseUrl } = await listen(appWith(database))

  try {
    const headers = { 'content-type': 'application/json' }

    if (idempotency !== undefined) {
      headers['idempotency-key'] = idempotency
    }

    if (cookie !== undefined) {
      headers.cookie = cookie
    }

    if (authorization !== undefined) {
      headers.authorization = authorization
    }

    const response = await fetch(`${baseUrl}/api/v1/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const payload = await response.json()

    return { status: response.status, payload }
  } finally {
    await close(server)
  }
}

describe('POST /api/v1/checkout', () => {
  it('rejects a missing Idempotency-Key before reading the database', async () => {
    const database = fakeDatabase()
    const result = await request(database, { idempotency: undefined })

    assert.equal(result.status, 400)
    assert.equal(result.payload.error.code, 'VALIDATION_ERROR')
    assert.equal(result.payload.error.details[0].path, 'Idempotency-Key')
    assert.equal(database.calls.length, 0)
  })

  it('rejects an Idempotency-Key outside the stored format', async () => {
    const database = fakeDatabase()
    const tooLong = await request(database, { idempotency: 'a'.repeat(256) })
    const spaced = await request(database, { idempotency: 'not a key' })

    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.payload.error.code, 'VALIDATION_ERROR')
    assert.equal(spaced.status, 400)
    assert.equal(spaced.payload.error.details[0].path, 'Idempotency-Key')
    assert.equal(database.calls.length, 0)
  })

  it('rejects a body outside the billing snapshot', async () => {
    const database = fakeDatabase()
    const result = await request(database, {
      cookie: `shop_guest_session=${sessionId}`,
      body: { ...validBody(), shippingAddress: { street: 'Inna' } },
    })

    assert.equal(result.status, 400)
    assert.equal(result.payload.error.code, 'VALIDATION_ERROR')
    assert.equal(database.calls.length, 0)
  })

  it('rejects a guest checkout without a session cookie', async () => {
    const database = fakeDatabase()
    const result = await request(database)

    assert.equal(result.status, 401)
    assert.equal(result.payload.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
  })

  it('rejects an invalid bearer token without opening the guest cart', async () => {
    const database = fakeDatabase({
      owner: sessionHash,
      carts: [{ id: cartId, status: 'active' }],
      items: [{ product_id: productId, is_active: true }],
    })
    const result = await request(database, {
      authorization: 'Bearer wrong-token',
      cookie: `shop_guest_session=${sessionId}`,
    })

    assert.equal(result.status, 401)
    assert.equal(result.payload.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
  })

  it('rejects repeated Authorization headers before authentication', async () => {
    const database = fakeDatabase({
      seller: 'registered',
      owner: userId,
      carts: [{ id: cartId, status: 'active' }],
      items: [{ product_id: productId, is_active: true }],
    })
    const { server, port } = await listen(appWith(database))
    const payload = JSON.stringify(validBody())
    const raw = [
      'POST /api/v1/checkout HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(payload)}`,
      `Idempotency-Key: ${idempotencyKey}`,
      `Authorization: Bearer ${accountToken}`,
      'Authorization: Bearer second-token',
      'Connection: close',
      '',
      payload,
    ].join('\r\n')

    try {
      const result = await sendRaw(port, raw)

      assert.equal(result.status, 401)
      assert.equal(result.payload.error.code, 'UNAUTHORIZED')
      assert.equal(database.calls.length, 0)
    } finally {
      await close(server)
    }
  })

  it('rejects an online email above 50 characters before a transaction', async () => {
    const database = fakeDatabase()
    const result = await request(database, {
      cookie: `shop_guest_session=${sessionId}`,
      body: validBody({ email: `${'a'.repeat(39)}@example.com` }),
    })

    assert.equal(result.status, 400)
    assert.equal(result.payload.error.code, 'VALIDATION_ERROR')
    assert.equal(result.payload.error.details[0].path, 'email')
    assert.equal(database.calls.length, 0)
  })

  it('rejects a malformed guest session', async () => {
    const database = fakeDatabase()
    const result = await request(database, {
      cookie: 'shop_guest_session=short; shop_guest_session=short',
    })

    assert.equal(result.status, 401)
    assert.equal(result.payload.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
  })
})

function sendRaw(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(raw)
    })
    const chunks = []

    socket.on('data', (chunk) => {
      chunks.push(chunk)
    })
    socket.on('error', reject)
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])
      const body = text.slice(text.indexOf('\r\n\r\n') + 4)
      resolve({ status, payload: JSON.parse(body) })
    })
  })
}
