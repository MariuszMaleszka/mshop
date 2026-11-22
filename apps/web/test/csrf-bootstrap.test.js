import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  bootstrapCsrfChallenge,
  loginChallengeCookie,
  readAllowedOrigin,
} from '../server/utils/csrf-bootstrap.js'

const allowed = 'https://shop.example'
const secret = randomBytes(32).toString('base64')
const challengeId = randomBytes(32).toString('base64url')
const csrfSecret = randomBytes(32).toString('base64url')
const apiBase = 'http://127.0.0.1:3001/api/v1'

function request(remoteAddress = '203.0.113.10') {
  return {
    socket: { remoteAddress },
    headers: {
      'x-forwarded-for': '198.51.100.8',
      'x-mshop-client-ip': '192.0.2.9',
      origin: 'https://evil.example',
    },
  }
}

function issued(body = { challengeId, csrfSecret }, status = 200) {
  const calls = []

  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options })
      return Response.json(body, { status })
    },
  }
}

function input(overrides = {}) {
  return {
    origin: allowed,
    referer: 'https://evil.example/login',
    request: request(),
    allowedOrigin: allowed,
    secret,
    apiBase,
    nodeEnv: 'test',
    ...overrides,
  }
}

describe('csrf bootstrap source', () => {
  it('accepts the configured origin and a referer when origin is absent', async () => {
    const exact = issued()
    const referer = issued()
    const fromOrigin = await bootstrapCsrfChallenge({
      ...input(),
      fetchImpl: exact.fetch,
    })
    const fromReferer = await bootstrapCsrfChallenge({
      ...input({ origin: undefined, referer: `${allowed}/login?next=1#form` }),
      fetchImpl: referer.fetch,
    })

    assert.equal(fromOrigin.status, 200)
    assert.equal(fromReferer.status, 200)
    assert.equal(exact.calls.length, 1)
    assert.equal(referer.calls.length, 1)
  })

  it('rejects a bad origin, a missing source, and a null origin without calling Express', async () => {
    const calls = []
    const fetchImpl = async () => {
      calls.push('fetch')
      return Response.json({ challengeId, csrfSecret })
    }

    const badOrigin = await bootstrapCsrfChallenge({
      ...input({ origin: 'https://evil.example', referer: `${allowed}/login` }),
      fetchImpl,
    })
    const missing = await bootstrapCsrfChallenge({
      ...input({ origin: undefined, referer: undefined }),
      fetchImpl,
    })
    const nullOrigin = await bootstrapCsrfChallenge({
      ...input({ origin: 'null', referer: `${allowed}/login` }),
      fetchImpl,
    })

    for (const result of [badOrigin, missing, nullOrigin]) {
      assert.equal(result.status, 403)
      assert.deepEqual(result.body, { code: 'forbidden' })
      assert.equal(result.cookie, null)
    }

    assert.deepEqual(calls, [])
  })

  it('rejects another scheme, host, or port', async () => {
    const calls = []
    const fetchImpl = async () => {
      calls.push('fetch')
      return Response.json({})
    }

    for (const origin of [
      'http://shop.example',
      'https://shop.example.evil',
      'https://evil.shop.example',
      'https://shop.example:444',
    ]) {
      const result = await bootstrapCsrfChallenge({
        ...input({ origin, referer: `${allowed}/login` }),
        fetchImpl,
      })

      assert.equal(result.status, 403)
    }

    assert.deepEqual(calls, [])
  })

  it('returns 503 when the allowed origin is missing or not canonical', async () => {
    const calls = []
    const fetchImpl = async () => {
      calls.push('fetch')
      return Response.json({})
    }
    const missing = await bootstrapCsrfChallenge({
      ...input({ allowedOrigin: '' }),
      fetchImpl,
    })
    const path = await bootstrapCsrfChallenge({
      ...input({ allowedOrigin: `${allowed}/shop` }),
      fetchImpl,
    })

    assert.equal(missing.status, 503)
    assert.equal(path.status, 503)
    assert.deepEqual(calls, [])
    assert.equal(readAllowedOrigin({ env: {}, runtimeConfig: {} }), '')
    assert.equal(
      readAllowedOrigin({
        env: { WEB_ORIGIN: allowed },
        runtimeConfig: { bffAllowedOrigin: '' },
      }),
      allowed,
    )
    assert.equal(
      readAllowedOrigin({
        env: { WEB_ORIGIN: allowed },
        runtimeConfig: { bffAllowedOrigin: 'https://other.example' },
      }),
      'https://other.example',
    )
  })
})

describe('csrf bootstrap internal call', () => {
  it('posts only the internal headers from the socket address', async () => {
    const transport = issued()
    const result = await bootstrapCsrfChallenge({
      ...input(),
      fetchImpl: transport.fetch,
    })

    assert.equal(result.status, 200)
    assert.equal(
      transport.calls[0].url,
      'http://127.0.0.1:3001/api/v1/internal/login-challenges',
    )
    assert.deepEqual(transport.calls[0].options.headers, {
      'x-mshop-client-ip': '203.0.113.10',
      'x-mshop-internal-secret': secret,
    })
    assert.equal(transport.calls[0].options.method, 'POST')
  })

  it('does not call Express without a socket, a secret, or a valid Express response', async () => {
    const calls = []
    const fetchImpl = async () => {
      calls.push('fetch')
      return Response.json({ challengeId, csrfSecret })
    }
    const noSocket = await bootstrapCsrfChallenge({
      ...input({
        request: { headers: { 'x-mshop-client-ip': '203.0.113.10' } },
      }),
      fetchImpl,
    })
    const noSecret = await bootstrapCsrfChallenge({
      ...input({ secret: '' }),
      fetchImpl,
    })
    const badSecret = await bootstrapCsrfChallenge({
      ...input({ secret: 'not-a-secret' }),
      fetchImpl,
    })

    assert.equal(noSocket.status, 503)
    assert.equal(noSecret.status, 503)
    assert.equal(badSecret.status, 503)
    assert.deepEqual(calls, [])

    const badBody = issued({ challengeId, expiresAt: 'soon' })
    const rejected = await bootstrapCsrfChallenge({
      ...input(),
      fetchImpl: badBody.fetch,
    })

    assert.equal(badBody.calls.length, 1)
    assert.equal(rejected.status, 503)
    assert.equal(rejected.cookie, null)
    assert.equal(JSON.stringify(rejected.body).includes(csrfSecret), false)
  })
})

describe('csrf bootstrap cookie', () => {
  it('keeps the local and production cookie flags exact', () => {
    const local = loginChallengeCookie('test', challengeId)
    const production = loginChallengeCookie('production', challengeId)

    assert.equal(local.name, 'mshop_login')
    assert.equal(local.value, challengeId)
    assert.deepEqual(local.options, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    })
    assert.equal(local.options.domain, undefined)
    assert.equal(production.name, '__Host-mshop_login')
    assert.equal(production.options.secure, true)
    assert.equal(production.options.domain, undefined)
    assert.equal(production.options.httpOnly, true)
    assert.equal(production.options.sameSite, 'lax')
    assert.equal(production.options.path, '/')
    assert.equal(production.options.maxAge, 600)
  })

  it('returns only the csrf secret after a valid issue', async () => {
    const transport = issued()
    const result = await bootstrapCsrfChallenge({
      ...input({ nodeEnv: 'production' }),
      fetchImpl: transport.fetch,
    })
    const visible = JSON.stringify(result.body)

    assert.deepEqual(result.body, { csrfSecret })
    assert.equal(result.cookie.name, '__Host-mshop_login')
    assert.equal(result.cookie.value, challengeId)
    assert.equal(visible.includes(challengeId), false)
    assert.equal(visible.includes(secret), false)
  })

  it('does not return the secret when the challenge id cannot be a cookie', async () => {
    const transport = issued({ challengeId: 'not-a-challenge', csrfSecret })
    const result = await bootstrapCsrfChallenge({
      ...input(),
      fetchImpl: transport.fetch,
    })

    assert.equal(result.status, 503)
    assert.equal(result.cookie, null)
    assert.equal(JSON.stringify(result.body).includes(csrfSecret), false)
  })

  it('maps an Express limit and an Express failure without the secret', async () => {
    const limited = issued({}, 429)
    const denied = issued({ code: 'forbidden' }, 403)
    const limit = await bootstrapCsrfChallenge({
      ...input(),
      fetchImpl: limited.fetch,
    })
    const failure = await bootstrapCsrfChallenge({
      ...input(),
      fetchImpl: denied.fetch,
    })

    assert.equal(limit.status, 429)
    assert.deepEqual(limit.body, { code: 'rate_limited' })
    assert.equal(limit.cookie, null)
    assert.equal(failure.status, 503)
    assert.equal(failure.cookie, null)
    assert.equal(JSON.stringify(failure.body).includes('forbidden'), false)
  })
})
