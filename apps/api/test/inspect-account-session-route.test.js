import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { handleInspectAccountSession } from '../src/account-session/inspect-account-session-route.js'
import { AccountSessionInspectError } from '../src/account-session/inspect-account-session.js'
import { registerLoginChallengeRoutes } from '../src/account-session/routes.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/http/logger.js'

const secret = randomBytes(32)
const secretText = secret.toString('base64')
const sessionKey = randomBytes(32)
const sessionHash = createHash('sha256')
  .update('session-id', 'utf8')
  .digest('hex')
const userId = randomUUID()
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

function readyResult() {
  return {
    status: 'ready',
    userId,
    accessToken,
    refreshToken,
    keyVersion: 1,
  }
}

function dependencies(inspectAndExtend) {
  return {
    database: { async query() {} },
    bffInternalSecret: secret,
    bffTrustedPeers: ['127.0.0.1', '::1'],
    sessionTokenKey: sessionKey,
    inspectAndExtend,
  }
}

async function listen(inspectAndExtend) {
  const app = createApp(config, {
    logger: createLogger({ nodeEnv: 'test' }),
    registerRoutes(router) {
      registerLoginChallengeRoutes(router, dependencies(inspectAndExtend))
    },
  })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  return {
    server,
    port: typeof address === 'object' && address ? address.port : 0,
  }
}

async function post(
  port,
  { headers = {}, payload = { sessionHash }, raw } = {},
) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/v1/internal/account-sessions/inspect`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.20',
        'x-mshop-client-ip': '203.0.113.10',
        'x-mshop-internal-secret': secretText,
        ...headers,
      },
      body: raw === undefined ? JSON.stringify(payload) : raw,
    },
  )
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: await response.json(),
  }
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function hidden(body) {
  const visible = JSON.stringify(body)
  assert.equal(visible.includes(accessToken), false)
  assert.equal(visible.includes(refreshToken), false)
  assert.equal(visible.includes(sessionHash), false)
  assert.equal(visible.includes(secretText), false)
}

describe('internal account session inspect', () => {
  it('returns the ready session once and does not trust forwarded addresses', async () => {
    const calls = []
    const { server, port } = await listen(async (input) => {
      calls.push(input)
      return readyResult()
    })

    try {
      const response = await post(port, {
        payload: { sessionHash, clientIp: '192.0.2.9' },
      })

      assert.equal(response.status, 400)
      assert.equal(response.cacheControl, 'no-store')
      assert.deepEqual(response.body, { code: 'invalid_request' })
      assert.equal(calls.length, 0)

      const accepted = await post(port)
      assert.equal(accepted.status, 200)
      assert.equal(accepted.cacheControl, 'no-store')
      assert.deepEqual(accepted.body, readyResult())
      assert.deepEqual(Object.keys(accepted.body).sort(), [
        'accessToken',
        'keyVersion',
        'refreshToken',
        'status',
        'userId',
      ])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].sessionHash, sessionHash)
      assert.equal(calls[0].key, sessionKey)
      assert.equal(Object.hasOwn(calls[0], 'clientIp'), false)
    } finally {
      await close(server)
    }
  })

  it('rejects an untrusted peer and a bad secret before inspection', async () => {
    let called = false
    const inspectAndExtend = async () => {
      called = true
      return readyResult()
    }
    const peer = await handleInspectAccountSession(
      {
        socket: { remoteAddress: '198.51.100.9' },
        headers: {
          'x-forwarded-for': '127.0.0.1',
          'x-mshop-client-ip': '203.0.113.10',
          'x-mshop-internal-secret': secretText,
        },
        body: { sessionHash },
      },
      dependencies(inspectAndExtend),
    )
    const { server, port } = await listen(inspectAndExtend)

    try {
      const denied = await post(port, {
        headers: { 'x-mshop-internal-secret': 'wrong-secret' },
      })

      assert.equal(peer.status, 403)
      assert.deepEqual(peer.body, { code: 'forbidden' })
      assert.equal(denied.status, 403)
      assert.equal(denied.cacheControl, 'no-store')
      assert.deepEqual(denied.body, { code: 'forbidden' })
      hidden(denied.body)
      assert.equal(called, false)
    } finally {
      await close(server)
    }
  })

  it('rejects a missing or malformed body before inspection', async () => {
    let called = false
    const { server, port } = await listen(async () => {
      called = true
      return readyResult()
    })

    try {
      const missing = await post(port, { payload: {} })
      const malformed = await post(port, {
        payload: { sessionHash: sessionHash.toUpperCase() },
      })

      for (const response of [missing, malformed]) {
        assert.equal(response.status, 400)
        assert.equal(response.cacheControl, 'no-store')
        assert.deepEqual(response.body, { code: 'invalid_request' })
        hidden(response.body)
      }
      assert.equal(called, false)
    } finally {
      await close(server)
    }
  })

  it('maps session results without returning tokens for denials', async () => {
    const cases = [
      ['not_found', 401, 'invalid_session'],
      ['expired', 401, 'invalid_session'],
      ['pending', 503, 'session_pending'],
      ['stale_pending', 401, 'invalid_session'],
      ['unknown', 401, 'invalid_session'],
      ['invalid', 401, 'invalid_session'],
      ['unavailable', 401, 'invalid_session'],
    ]
    let calls = 0
    const { server, port } = await listen(async () => {
      calls += 1
      return {
        status: cases[calls - 1][0],
        accessToken,
        refreshToken,
      }
    })

    try {
      for (const [, status, code] of cases) {
        const response = await post(port)
        assert.equal(response.status, status)
        assert.equal(response.cacheControl, 'no-store')
        assert.deepEqual(response.body, { code })
        hidden(response.body)
      }
      assert.equal(calls, cases.length)
    } finally {
      await close(server)
    }
  })

  it('hides technical and unexpected failures', async () => {
    const failures = [
      new AccountSessionInspectError('unavailable'),
      new Error(`database ${accessToken} ${sessionHash}`),
    ]
    const { server, port } = await listen(async () => {
      throw failures.shift()
    })

    try {
      const technical = await post(port)
      const unexpected = await post(port)

      assert.equal(technical.status, 503)
      assert.equal(technical.cacheControl, 'no-store')
      assert.deepEqual(technical.body, { code: 'service_unavailable' })
      assert.equal(unexpected.status, 500)
      assert.equal(unexpected.cacheControl, 'no-store')
      assert.deepEqual(unexpected.body, { code: 'internal_error' })
      hidden(technical.body)
      hidden(unexpected.body)
    } finally {
      await close(server)
    }
  })

  it('leaves invalid JSON to the global parser before this route', async () => {
    const { server, port } = await listen(async () => readyResult())

    try {
      const response = await post(port, { raw: '{' })

      assert.equal(response.status, 400)
      assert.equal(response.cacheControl, null)
      assert.equal(JSON.stringify(response.body).includes(accessToken), false)
    } finally {
      await close(server)
    }
  })
})
