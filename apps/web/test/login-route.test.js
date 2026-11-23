import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const allowed = 'https://shop.example'
const secret = randomBytes(32).toString('base64')
const challengeId = randomBytes(32).toString('base64url')
const csrfSecret = randomBytes(32).toString('base64url')
const sessionId = randomBytes(32).toString('base64url')
const nextCsrf = randomBytes(32).toString('base64url')
const apiBase = 'http://127.0.0.1:3001/api/v1'
const state = {
  fetchStatus: 200,
  fetchBody: { sessionId, csrfSecret: nextCsrf },
  failCookie: false,
}
const fetchCalls = []
const originalFetch = globalThis.fetch

globalThis.defineEventHandler = (handler) => handler
globalThis.setResponseHeader = (event, name, value) => {
  event.node.res.setHeader(name, value)
}
globalThis.getRequestHeader = (event, name) =>
  event.node.req.headers[String(name).toLowerCase()]
globalThis.setCookie = (event, name, value, options) => {
  if (state.failCookie) {
    throw new Error('cookie store failed')
  }

  event.cookies.push({ name, value, options })
}
globalThis.deleteCookie = (event, name, options) => {
  event.cleared.push({ name, options })
}
globalThis.setResponseStatus = (event, status) => {
  event.status = status
}
globalThis.readBody = async (event) => event.body
globalThis.useRuntimeConfig = () => ({
  bffInternalSecret: secret,
  bffAllowedOrigin: allowed,
  public: { apiBase },
})
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options })

  if (String(url).endsWith('/internal/login-sessions/discard')) {
    return Response.json({ code: 'discarded' })
  }

  return Response.json(state.fetchBody, { status: state.fetchStatus })
}

const { default: handler } = await import('../server/api/v1/auth/login.post.js')

function createEvent(headers = {}) {
  return {
    status: undefined,
    cookies: [],
    cleared: [],
    body: { email: 'person@example.com', password: 'correct-horse-battery' },
    node: {
      req: {
        socket: { remoteAddress: '203.0.113.10' },
        headers: {
          origin: allowed,
          cookie: `mshop_login=${challengeId}`,
          'x-csrf-token': csrfSecret,
          ...headers,
        },
      },
      res: {
        headers: new Map(),
        setHeader(name, value) {
          this.headers.set(String(name).toLowerCase(), value)
        },
        getHeader(name) {
          return this.headers.get(String(name).toLowerCase())
        },
      },
    },
  }
}

describe('login route', () => {
  after(() => {
    globalThis.fetch = originalFetch
  })

  it('sets no-store, the session cookie, and clears the challenge', async () => {
    state.fetchStatus = 200
    state.failCookie = false
    fetchCalls.length = 0
    const event = createEvent()
    const body = await handler(event)

    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(event.status, 200)
    assert.deepEqual(body, { csrfSecret: nextCsrf })
    assert.equal(JSON.stringify(body).includes(sessionId), false)
    assert.equal(event.cookies.length, 1)
    assert.equal(event.cookies[0].name, 'mshop_session')
    assert.equal(event.cookies[0].options.httpOnly, true)
    assert.equal(event.cookies[0].options.maxAge, 12 * 60 * 60)
    assert.equal(event.cleared.length, 1)
    assert.equal(event.cleared[0].name, 'mshop_login')
    assert.equal(fetchCalls.length, 1)
  })

  it('sets no-store and keeps the challenge cookie when origin is rejected', async () => {
    fetchCalls.length = 0
    const event = createEvent({ origin: 'https://evil.example' })
    const body = await handler(event)

    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(event.status, 403)
    assert.deepEqual(body, { code: 'forbidden' })
    assert.equal(event.cookies.length, 0)
    assert.equal(event.cleared.length, 0)
    assert.equal(fetchCalls.length, 0)
  })

  it('sets no-store for Express failures and a cookie store failure', async () => {
    state.fetchStatus = 401
    fetchCalls.length = 0
    const denied = createEvent()
    const deniedBody = await handler(denied)

    assert.equal(denied.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(denied.status, 401)
    assert.deepEqual(deniedBody, { code: 'invalid_credentials' })
    assert.equal(denied.cleared.length, 1)
    assert.equal(denied.cookies.length, 0)

    state.fetchStatus = 503
    const unavailable = createEvent()
    const unavailableBody = await handler(unavailable)
    assert.equal(unavailable.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(unavailable.status, 503)

    state.fetchStatus = 500
    const unexpected = createEvent()
    const unexpectedBody = await handler(unexpected)
    assert.equal(unexpected.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(unexpected.status, 500)
    assert.deepEqual(unexpectedBody, { code: 'internal_error' })

    state.fetchStatus = 200
    state.failCookie = true
    fetchCalls.length = 0
    const failedCookie = createEvent()
    const failedBody = await handler(failedCookie)

    assert.equal(failedCookie.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(failedCookie.status, 503)
    assert.deepEqual(failedBody, { code: 'unavailable' })
    assert.equal(failedCookie.cookies.length, 0)
    assert.equal(failedCookie.cleared.length, 1)
    assert.equal(fetchCalls.length, 2)
    assert.equal(JSON.stringify(failedBody).includes(sessionId), false)
    assert.equal(JSON.stringify(unavailableBody).includes(sessionId), false)
  })
})
