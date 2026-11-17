import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'
import { registerGuestSessionRoutes } from '../src/session/routes.js'
import {
  hashGuestSessionId,
  readGuestSessionId,
} from '../src/session/guest-session.js'

const testConfig = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const productionConfig = loadConfig({
  NODE_ENV: 'production',
  PORT: '8080',
  WEB_ORIGIN: 'https://shop.example',
  DATABASE_URL: 'postgresql://app:long-lived-db-password@db.internal:5432/shop',
  SUPABASE_URL: 'https://project.supabase.co',
})
const existingId = 'ab'.repeat(32)
const maxAge = String(30 * 24 * 60 * 60)

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

function appWith(config, database, lines) {
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
      registerGuestSessionRoutes(router, { nodeEnv: config.nodeEnv })
    },
  })
}

async function postGuest(app, { cookie, body } = {}) {
  const { server, baseUrl } = await listen(app)

  try {
    const headers = { 'content-type': 'application/json' }

    if (cookie !== undefined) {
      headers.cookie = cookie
    }

    const response = await fetch(`${baseUrl}/api/v1/session/guest`, {
      method: 'POST',
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

function sessionCookie(setCookie) {
  const header = setCookie.find((value) =>
    value.startsWith('shop_guest_session='),
  )

  assert.ok(header)
  return header
}

function cookieValue(header) {
  return header.slice('shop_guest_session='.length).split(';', 1)[0]
}

describe('guest session id', () => {
  it('hashes the cookie value with SHA-256 and ignores invalid cookies', () => {
    const hash = hashGuestSessionId(existingId)

    assert.equal(
      hash,
      createHash('sha256').update(existingId, 'utf8').digest('hex'),
    )
    assert.equal(readGuestSessionId(undefined), null)
    assert.equal(readGuestSessionId('shop_guest_session=SHORT'), null)
    assert.equal(
      readGuestSessionId(`shop_guest_session=${existingId}`),
      existingId,
    )
  })
})

describe('POST /api/v1/session/guest', () => {
  it('creates a session cookie when none is present', async () => {
    const lines = []
    const database = {
      calls: 0,
      async query() {
        this.calls += 1
        throw new Error('database must not be used')
      },
    }
    const result = await postGuest(appWith(testConfig, database, lines), {
      body: { sessionId: existingId },
    })
    const header = sessionCookie(result.setCookie)
    const sessionId = cookieValue(header)
    const hash = hashGuestSessionId(sessionId)

    assert.equal(result.status, 200)
    assert.deepEqual(result.body, {
      data: { authenticated: false },
      meta: {},
    })
    assert.match(sessionId, /^[0-9a-f]{64}$/)
    assert.notEqual(sessionId, existingId)
    assert.match(header, /HttpOnly/i)
    assert.match(header, /SameSite=Lax/i)
    assert.match(header, /Path=\//i)
    assert.equal(/;\s*Secure/i.test(header), false)
    assert.equal(/;\s*Domain=/i.test(header), false)
    assert.match(header, new RegExp(`Max-Age=${maxAge}`))
    assert.equal(result.text.includes(sessionId), false)
    assert.equal(result.text.includes(hash), false)
    assert.equal(lines.join('\n').includes(sessionId), false)
    assert.equal(lines.join('\n').includes(hash), false)
    assert.equal(database.calls, 0)
  })

  it('keeps a valid session id and refreshes the cookie lifetime', async () => {
    const lines = []
    const result = await postGuest(appWith(testConfig, null, lines), {
      cookie: `theme=light; shop_guest_session=${existingId}`,
    })
    const header = sessionCookie(result.setCookie)

    assert.equal(cookieValue(header), existingId)
    assert.match(header, new RegExp(`Max-Age=${maxAge}`))
    assert.equal(result.text.includes(existingId), false)
    assert.equal(lines.join('\n').includes(existingId), false)
    assert.equal(
      lines.join('\n').includes(hashGuestSessionId(existingId)),
      false,
    )
  })

  it('replaces a cookie that is not 64 lowercase hex characters', async () => {
    const lines = []
    const result = await postGuest(appWith(testConfig, null, lines), {
      cookie: 'shop_guest_session=NOT-A-VALID-SESSION',
    })
    const sessionId = cookieValue(sessionCookie(result.setCookie))

    assert.match(sessionId, /^[0-9a-f]{64}$/)
    assert.equal(result.text.includes('NOT-A-VALID-SESSION'), false)
    assert.equal(lines.join('\n').includes('NOT-A-VALID-SESSION'), false)
  })

  it('sets Secure only in production', async () => {
    const lines = []
    const result = await postGuest(appWith(productionConfig, null, lines))
    const header = sessionCookie(result.setCookie)

    assert.match(header, /;\s*Secure/i)
    assert.match(header, /HttpOnly/i)
    assert.match(header, /SameSite=Lax/i)
    assert.equal(result.body.data.authenticated, false)
  })
})
