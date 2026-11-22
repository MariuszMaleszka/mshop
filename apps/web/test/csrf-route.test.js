import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const allowed = 'https://shop.example'
const secret = randomBytes(32).toString('base64')
const challengeId = randomBytes(32).toString('base64url')
const csrfSecret = randomBytes(32).toString('base64url')
const apiBase = 'http://127.0.0.1:3001/api/v1'
const state = {
  secret,
  throwConfig: false,
  fetchStatus: 200,
  fetchBody: { challengeId, csrfSecret },
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
  event.cookies.push({ name, value, options })
}
globalThis.setResponseStatus = (event, status) => {
  event.status = status
}
globalThis.useRuntimeConfig = () => {
  if (state.throwConfig) {
    throw new Error('config failed')
  }

  return {
    bffInternalSecret: state.secret,
    bffAllowedOrigin: allowed,
    public: { apiBase },
  }
}
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options })
  return Response.json(state.fetchBody, { status: state.fetchStatus })
}

const { default: handler } = await import('../server/api/v1/auth/csrf.post.js')

function createEvent(headers = { origin: allowed }) {
  return {
    status: undefined,
    cookies: [],
    node: {
      req: {
        socket: { remoteAddress: '203.0.113.10' },
        headers,
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

function resetState() {
  state.secret = secret
  state.throwConfig = false
  state.fetchStatus = 200
  state.fetchBody = { challengeId, csrfSecret }
  fetchCalls.length = 0
}

describe('csrf route cache header', () => {
  after(() => {
    globalThis.fetch = originalFetch
  })

  it('sets no-store before a successful response', async () => {
    resetState()
    const event = createEvent()
    const body = await handler(event)

    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(event.status, 200)
    assert.deepEqual(body, { csrfSecret })
    assert.equal(event.cookies.length, 1)
    assert.equal(event.cookies[0].value, challengeId)
    assert.equal(fetchCalls.length, 1)
  })

  it('sets no-store on a rejected origin before Express is called', async () => {
    resetState()
    const event = createEvent({ origin: 'https://evil.example' })
    const body = await handler(event)

    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(event.status, 403)
    assert.deepEqual(body, { code: 'forbidden' })
    assert.equal(event.cookies.length, 0)
    assert.equal(fetchCalls.length, 0)
  })

  it('sets no-store when the limit is reached', async () => {
    resetState()
    state.fetchStatus = 429
    const event = createEvent()
    const body = await handler(event)

    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(event.status, 429)
    assert.deepEqual(body, { code: 'rate_limited' })
    assert.equal(event.cookies.length, 0)
    assert.equal(JSON.stringify(body).includes(csrfSecret), false)
  })

  it('sets no-store when configuration fails before Express is called', async () => {
    resetState()
    state.secret = ''
    const event = createEvent()
    const body = await handler(event)

    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(event.status, 503)
    assert.deepEqual(body, { code: 'unavailable' })
    assert.equal(event.cookies.length, 0)
    assert.equal(fetchCalls.length, 0)
    assert.equal(JSON.stringify(body).includes(csrfSecret), false)
  })

  it('keeps no-store when request setup throws', async () => {
    resetState()
    state.throwConfig = true
    const event = createEvent()

    await assert.rejects(() => handler(event), /config failed/)
    assert.equal(event.node.res.getHeader('cache-control'), 'no-store')
    assert.equal(event.cookies.length, 0)
    assert.equal(fetchCalls.length, 0)
  })
})
