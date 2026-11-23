import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { sha256Hex } from '../../api/src/account-session/repository.js'
import { loginAccount } from '../server/utils/account-login.js'

const allowed = 'https://shop.example'
const secret = randomBytes(32).toString('base64')
const challengeId = randomBytes(32).toString('base64url')
const csrfSecret = randomBytes(32).toString('base64url')
const sessionId = randomBytes(32).toString('base64url')
const nextCsrf = randomBytes(32).toString('base64url')
const previousSessionId = randomBytes(32).toString('base64url')
const apiBase = 'http://127.0.0.1:3001/api/v1'
const email = 'person@example.com'
const password = 'correct-horse-battery'
const accessToken = 'access-token-value'

function request(remoteAddress = '203.0.113.10') {
  return { socket: { remoteAddress } }
}

function input(overrides = {}) {
  return {
    origin: allowed,
    cookieHeader: `mshop_login=${challengeId}`,
    csrfToken: csrfSecret,
    readBody: async () => ({ email, password }),
    request: request(),
    allowedOrigin: allowed,
    secret,
    apiBase,
    nodeEnv: 'test',
    commitSessionCookie() {},
    ...overrides,
  }
}

function issued(body = { sessionId, csrfSecret: nextCsrf }, status = 200) {
  const calls = []

  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return Response.json(body, { status })
    },
  }
}

describe('account login', () => {
  it('calls Express once and returns only the new csrf secret with a session cookie', async () => {
    const transport = issued()
    const cookies = []
    const result = await loginAccount({
      ...input({
        commitSessionCookie(cookie) {
          cookies.push(cookie)
        },
      }),
      fetchImpl: transport.fetch,
    })

    assert.equal(transport.calls.length, 1)
    assert.equal(transport.calls[0].url, `${apiBase}/internal/login`)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { csrfSecret: nextCsrf })
    assert.equal(Object.hasOwn(result.body, 'sessionId'), false)
    assert.equal(JSON.stringify(result.body).includes(sessionId), false)
    assert.equal(JSON.stringify(result.body).includes(accessToken), false)
    assert.equal(cookies.length, 1)
    assert.equal(cookies[0].name, 'mshop_session')
    assert.equal(cookies[0].value, sessionId)
    assert.deepEqual(cookies[0].options, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60,
    })
    assert.equal(Object.hasOwn(cookies[0].options, 'domain'), false)
    assert.equal(result.clearChallenge, true)
    assert.equal(result.challengeCookie.name, 'mshop_login')
    assert.equal(result.challengeCookie.options.httpOnly, true)
    assert.equal(result.challengeCookie.options.secure, false)
    assert.equal(result.challengeCookie.options.sameSite, 'lax')
    assert.equal(result.challengeCookie.options.path, '/')
  })

  it('uses the production cookie names and secure flag', async () => {
    const transport = issued()
    const cookies = []
    const result = await loginAccount({
      ...input({
        nodeEnv: 'production',
        cookieHeader: `__Host-mshop_login=${challengeId}`,
        commitSessionCookie(cookie) {
          cookies.push(cookie)
        },
      }),
      fetchImpl: transport.fetch,
    })

    assert.equal(cookies[0].name, '__Host-mshop_session')
    assert.equal(cookies[0].options.secure, true)
    assert.equal(Object.hasOwn(cookies[0].options, 'domain'), false)
    assert.equal(result.challengeCookie.name, '__Host-mshop_login')
    assert.equal(result.challengeCookie.options.secure, true)
  })

  it('accepts a matching referer when origin is absent', async () => {
    const transport = issued()
    const result = await loginAccount({
      ...input({ origin: undefined, referer: `${allowed}/login?next=1` }),
      fetchImpl: transport.fetch,
    })

    assert.equal(result.status, 200)
    assert.equal(transport.calls.length, 1)
  })

  it('rejects a bad origin and a bad referer before Express and keeps the challenge cookie', async () => {
    const calls = []
    const fetchImpl = async () => {
      calls.push('fetch')
      return Response.json({ sessionId, csrfSecret: nextCsrf })
    }
    const badOrigin = await loginAccount({
      ...input({ origin: 'https://evil.example', referer: `${allowed}/login` }),
      fetchImpl,
    })
    const badReferer = await loginAccount({
      ...input({ origin: undefined, referer: 'https://evil.example/login' }),
      fetchImpl,
    })

    for (const result of [badOrigin, badReferer]) {
      assert.equal(result.status, 403)
      assert.deepEqual(result.body, { code: 'forbidden' })
      assert.equal(result.clearChallenge, false)
    }

    assert.deepEqual(calls, [])
  })

  it('rejects a missing, duplicated, or malformed challenge cookie', async () => {
    const calls = []
    const fetchImpl = async () => {
      calls.push('fetch')
      return Response.json({})
    }

    for (const cookieHeader of [
      'theme=light',
      `mshop_login=${challengeId}; mshop_login=${challengeId}`,
      'mshop_login=not-a-challenge',
    ]) {
      const result = await loginAccount({
        ...input({ cookieHeader }),
        fetchImpl,
      })

      assert.equal(result.status, 403)
      assert.equal(result.clearChallenge, false)
    }

    assert.deepEqual(calls, [])
  })

  it('rejects a missing csrf secret and a bad body before Express', async () => {
    const calls = []
    const fetchImpl = async () => {
      calls.push('fetch')
      return Response.json({})
    }
    const missingSecret = await loginAccount({
      ...input({ csrfToken: undefined }),
      fetchImpl,
    })
    const badBody = await loginAccount({
      ...input({
        readBody: async () => ({ email, password, clientIp: '192.0.2.9' }),
      }),
      fetchImpl,
    })

    assert.equal(missingSecret.status, 403)
    assert.equal(missingSecret.clearChallenge, false)
    assert.equal(badBody.status, 400)
    assert.deepEqual(badBody.body, { code: 'invalid_request' })
    assert.equal(badBody.clearChallenge, false)
    assert.equal(JSON.stringify(badBody.body).includes(email), false)
    assert.equal(JSON.stringify(badBody.body).includes(password), false)
    assert.deepEqual(calls, [])
  })

  it('omits a previous session when the cookie is absent', async () => {
    const transport = issued()
    await loginAccount({ ...input(), fetchImpl: transport.fetch })

    assert.equal(
      Object.hasOwn(transport.calls[0].body, 'previousSessionHash'),
      false,
    )
    assert.equal(transport.calls[0].body.password, password)
  })

  it('sends only the hash of a valid previous session cookie', async () => {
    const transport = issued()
    await loginAccount({
      ...input({
        cookieHeader: `mshop_login=${challengeId}; mshop_session=${previousSessionId}`,
      }),
      fetchImpl: transport.fetch,
    })
    const visible = JSON.stringify(transport.calls[0].body)

    assert.equal(
      transport.calls[0].body.previousSessionHash,
      sha256Hex(previousSessionId),
    )
    assert.equal(visible.includes(previousSessionId), false)
  })

  it('does not hash an invalid or duplicated previous session cookie', async () => {
    const duplicated = `${previousSessionId}`
    const invalid = 'not-a-session'
    const first = issued()
    const second = issued()

    await loginAccount({
      ...input({
        cookieHeader: `mshop_login=${challengeId}; mshop_session=${duplicated}; mshop_session=${duplicated}`,
      }),
      fetchImpl: first.fetch,
    })
    await loginAccount({
      ...input({
        cookieHeader: `mshop_login=${challengeId}; mshop_session=${invalid}`,
      }),
      fetchImpl: second.fetch,
    })

    for (const transport of [first, second]) {
      const visible = JSON.stringify(transport.calls[0].body)
      assert.equal(
        Object.hasOwn(transport.calls[0].body, 'previousSessionHash'),
        false,
      )
      assert.equal(visible.includes(sha256Hex(duplicated)), false)
      assert.equal(visible.includes(sha256Hex(invalid)), false)
      assert.equal(visible.includes(invalid), false)
    }
  })

  it('maps Express failures and clears the challenge after the attempt', async () => {
    const cases = [
      [401, 401, 'invalid_credentials'],
      [429, 429, 'rate_limited'],
      [503, 503, 'unavailable'],
      [500, 500, 'internal_error'],
      [418, 500, 'internal_error'],
    ]

    for (const [status, expected, code] of cases) {
      const transport = issued({ accessToken, sessionId }, status)
      const result = await loginAccount({
        ...input(),
        fetchImpl: transport.fetch,
      })

      assert.equal(result.status, expected)
      assert.deepEqual(result.body, { code })
      assert.equal(result.clearChallenge, true)
      assert.equal(JSON.stringify(result.body).includes(accessToken), false)
      assert.equal(JSON.stringify(result.body).includes(password), false)
      assert.equal(transport.calls.length, 1)
    }
  })

  it('clears the challenge when Express cannot be reached', async () => {
    const result = await loginAccount({
      ...input(),
      fetchImpl: async () => {
        throw new Error(`network ${password}`)
      },
    })

    assert.equal(result.status, 503)
    assert.deepEqual(result.body, { code: 'unavailable' })
    assert.equal(result.clearChallenge, true)
    assert.equal(JSON.stringify(result.body).includes(password), false)
  })

  it('discards the new session when the cookie cannot be stored', async () => {
    const calls = []
    const result = await loginAccount({
      ...input({
        commitSessionCookie() {
          throw new Error(`cookie ${sessionId} ${accessToken}`)
        },
      }),
      fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) })
        return Response.json({ sessionId, csrfSecret: nextCsrf })
      },
    })

    assert.equal(result.status, 503)
    assert.deepEqual(result.body, { code: 'unavailable' })
    assert.equal(result.clearChallenge, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, `${apiBase}/internal/login-sessions/discard`)
    assert.deepEqual(calls[1].body, { sessionHash: sha256Hex(sessionId) })
    assert.equal(JSON.stringify(calls[1].body).includes(sessionId), false)
    assert.equal(JSON.stringify(result.body).includes(nextCsrf), false)
    assert.equal(JSON.stringify(result.body).includes(sessionId), false)
  })
})
