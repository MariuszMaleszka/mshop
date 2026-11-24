import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { sha256Hex } from '../../api/src/account-session/repository.js'
import { accountSessionCookieName } from '../server/utils/account-login.js'
import { prepareInternalCallFromRequest } from '../server/utils/internal-call.js'
import { readAccountSession } from '../server/utils/read-account-session.js'

const secret = randomBytes(32).toString('base64')
const sessionId = randomBytes(32).toString('base64url')
const otherSessionId = randomBytes(32).toString('base64url')
const userId = randomUUID()
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'
const apiBase = 'http://127.0.0.1:3001/api/v1'
const socketAddress = '203.0.113.10'
const forwardedAddress = '192.0.2.20'

function runtimeConfig(secretValue = secret) {
  return {
    bffInternalSecret: secretValue,
    public: { apiBase },
  }
}

function requestFor(nodeEnv, cookie) {
  return {
    headers: {
      cookie,
      'x-forwarded-for': forwardedAddress,
      'x-mshop-client-ip': '198.51.100.8',
    },
    socket: { remoteAddress: socketAddress },
  }
}

function sessionCookie(nodeEnv, value = sessionId) {
  return `${accountSessionCookieName(nodeEnv)}=${value}`
}

function readyBody(extra = {}) {
  return {
    status: 'ready',
    userId,
    accessToken,
    refreshToken,
    keyVersion: 1,
    ...extra,
  }
}

function jsonResponse(status, body) {
  return {
    status,
    async json() {
      return body
    },
  }
}

async function read(
  overrides = {},
  fetchImpl = async () => jsonResponse(200, readyBody()),
) {
  const calls = []
  const nodeEnv = overrides.nodeEnv ?? 'development'
  const request =
    overrides.request === undefined
      ? requestFor(nodeEnv, overrides.cookie ?? sessionCookie(nodeEnv))
      : overrides.request
  const result = await readAccountSession({
    request,
    runtimeConfig:
      overrides.runtimeConfig === undefined
        ? runtimeConfig()
        : overrides.runtimeConfig,
    nodeEnv,
    timeoutMs: overrides.timeoutMs,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return fetchImpl(url, options)
    },
  })

  return { result, calls, request }
}

function hidden(result) {
  const visible = JSON.stringify(result)
  assert.equal(visible.includes(accessToken), false)
  assert.equal(visible.includes(refreshToken), false)
  assert.equal(visible.includes(sessionId), false)
  assert.equal(visible.includes(secret), false)
  assert.equal(visible.includes(sha256Hex(sessionId)), false)
}

describe('read account session', () => {
  it('does not call Express for an absent or rejected cookie', async () => {
    const nodeEnv = 'development'
    const name = accountSessionCookieName(nodeEnv)
    const cases = [
      undefined,
      '',
      'mshop_login=' + sessionId,
      `${name}=`,
      `${name}`,
      `${name}=%ZZ`,
      `${name}=${Buffer.from(sessionId, 'base64url').toString('base64')}`,
      `${name}=${sessionId}; ${name}=${sessionId}`,
    ]

    for (const cookie of cases) {
      const { result, calls } = await read({
        request:
          cookie === undefined
            ? { socket: { remoteAddress: socketAddress } }
            : requestFor(nodeEnv, cookie),
      })

      assert.deepEqual(result, { ok: false, code: 'invalid_session' })
      hidden(result)
      assert.equal(calls.length, 0)
    }
  })

  it('posts only the hash of the environment session cookie', async () => {
    for (const nodeEnv of ['development', 'production']) {
      const name = accountSessionCookieName(nodeEnv)
      const otherName = accountSessionCookieName(
        nodeEnv === 'production' ? 'development' : 'production',
      )
      const { result, calls, request } = await read({
        nodeEnv,
        cookie: `${otherName}=${otherSessionId}; theme=light; ${name}=${sessionId}`,
      })
      const expected = prepareInternalCallFromRequest(request, { secret })

      assert.deepEqual(result, {
        ok: true,
        userId,
        accessToken,
        refreshToken,
        keyVersion: 1,
      })
      assert.deepEqual(Object.keys(result).sort(), [
        'accessToken',
        'keyVersion',
        'ok',
        'refreshToken',
        'userId',
      ])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, `${apiBase}/internal/account-sessions/inspect`)
      assert.deepEqual(calls[0].body, { sessionHash: sha256Hex(sessionId) })
      assert.equal(calls[0].options.method, 'POST')
      assert.equal(calls[0].options.headers['content-type'], 'application/json')
      assert.equal(
        calls[0].options.headers['x-mshop-client-ip'],
        expected.headers['x-mshop-client-ip'],
      )
      assert.equal(
        calls[0].options.headers['x-mshop-internal-secret'],
        expected.headers['x-mshop-internal-secret'],
      )
      assert.equal(
        calls[0].options.headers['x-mshop-client-ip'],
        '203.0.113.10',
      )
      assert.equal(JSON.stringify(calls[0].body).includes(sessionId), false)
      assert.equal(
        JSON.stringify(calls[0].body).includes(forwardedAddress),
        false,
      )
      assert.equal(calls[0].options.signal instanceof AbortSignal, true)
    }
  })

  it('does not call Express without a secret or a usable socket address', async () => {
    const missingSecret = await read({ runtimeConfig: runtimeConfig('') })
    const publicOnly = await read({
      runtimeConfig: { public: { apiBase, bffInternalSecret: secret } },
    })
    const badPeer = await read({
      request: {
        headers: {
          cookie: sessionCookie('development'),
          'x-forwarded-for': '127.0.0.1',
        },
        socket: { remoteAddress: 'not-an-ip' },
      },
    })

    for (const outcome of [missingSecret, publicOnly, badPeer]) {
      assert.deepEqual(outcome.result, {
        ok: false,
        code: 'service_unavailable',
      })
      hidden(outcome.result)
      assert.equal(outcome.calls.length, 0)
    }
  })

  it('maps session failures without returning tokens', async () => {
    const cases = [
      [401, { code: 'invalid_session' }, 'invalid_session'],
      [503, { code: 'session_pending' }, 'session_pending'],
      [503, { code: 'service_unavailable' }, 'service_unavailable'],
    ]

    for (const [status, body, code] of cases) {
      const { result, calls } = await read({}, async () =>
        jsonResponse(status, body),
      )

      assert.deepEqual(result, { ok: false, code })
      hidden(result)
      assert.equal(calls.length, 1)
    }

    const leaked = await read({}, async () =>
      jsonResponse(401, {
        code: 'invalid_session',
        accessToken,
        refreshToken,
      }),
    )

    assert.deepEqual(leaked.result, {
      ok: false,
      code: 'service_unavailable',
    })
    hidden(leaked.result)
  })

  it('rejects an untrusted success body and an unknown status', async () => {
    const malformed = await read({}, async () =>
      jsonResponse(200, {
        status: 'ready',
        accessToken,
        refreshToken,
      }),
    )
    const extra = await read({}, async () =>
      jsonResponse(200, readyBody({ sessionHash: sha256Hex(sessionId) })),
    )
    const unknown = await read({}, async () =>
      jsonResponse(500, {
        code: 'internal_error',
        accessToken,
        refreshToken,
      }),
    )
    const broken = await read({}, async () => ({
      status: 200,
      async json() {
        throw new Error(`invalid json ${accessToken}`)
      },
    }))

    for (const outcome of [malformed, extra, unknown, broken]) {
      assert.deepEqual(outcome.result, {
        ok: false,
        code: 'service_unavailable',
      })
      hidden(outcome.result)
      assert.equal(outcome.calls.length, 1)
    }
  })

  it('stops after one network failure or timeout', async () => {
    let networkCalls = 0
    const network = await readAccountSession({
      request: requestFor('development', sessionCookie('development')),
      runtimeConfig: runtimeConfig(),
      nodeEnv: 'development',
      fetchImpl: async () => {
        networkCalls += 1
        throw new Error(`network ${accessToken} ${sessionId}`)
      },
    })
    let timeoutCalls = 0
    let timedOutBySignal = false
    const timedOut = await readAccountSession({
      request: requestFor('development', sessionCookie('development')),
      runtimeConfig: runtimeConfig(),
      nodeEnv: 'development',
      timeoutMs: 20,
      fetchImpl: (url, options) =>
        new Promise((resolve, reject) => {
          timeoutCalls += 1
          const timer = setTimeout(() => {
            reject(new Error(`hung ${accessToken}`))
          }, 1000)
          options.signal.addEventListener('abort', () => {
            timedOutBySignal = true
            clearTimeout(timer)
            reject(options.signal.reason)
          })
        }),
    })

    assert.deepEqual(network, { ok: false, code: 'service_unavailable' })
    assert.deepEqual(timedOut, { ok: false, code: 'service_unavailable' })
    hidden(network)
    hidden(timedOut)
    assert.equal(networkCalls, 1)
    assert.equal(timeoutCalls, 1)
    assert.equal(timedOutBySignal, true)
  })
})
