import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { handleDiscardLoginSession } from '../src/account-session/discard-login-session.js'
import { registerLoginChallengeRoutes } from '../src/account-session/routes.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/http/logger.js'

const secret = randomBytes(32)
const secretText = secret.toString('base64')
const sessionHash = createHash('sha256')
  .update('session-id', 'utf8')
  .digest('hex')
const otherHash = createHash('sha256')
  .update('other-session', 'utf8')
  .digest('hex')

function database() {
  const rows = new Set([sessionHash, otherHash])
  const calls = []

  return {
    calls,
    rows,
    async query(sql, params) {
      calls.push({ sql, params })
      const removed = rows.delete(params[0])
      return { rowCount: removed ? 1 : 0 }
    },
  }
}

function dependencies(store) {
  return {
    database: store,
    bffInternalSecret: secret,
    bffTrustedPeers: ['127.0.0.1', '::1'],
  }
}

describe('discard login session', () => {
  it('deletes only the named session hash for a trusted call', async () => {
    const store = database()
    const result = await handleDiscardLoginSession(
      {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          'x-mshop-client-ip': '203.0.113.10',
          'x-mshop-internal-secret': secretText,
        },
        body: { sessionHash },
      },
      dependencies(store),
    )

    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { code: 'discarded' })
    assert.equal(JSON.stringify(result.body).includes(sessionHash), false)
    assert.equal(store.calls.length, 1)
    assert.equal(store.calls[0].params[0], sessionHash)
    assert.equal(store.rows.has(sessionHash), false)
    assert.equal(store.rows.has(otherHash), true)
  })

  it('rejects an untrusted peer and a bad secret before touching sessions', async () => {
    const store = database()
    const peer = await handleDiscardLoginSession(
      {
        socket: { remoteAddress: '198.51.100.9' },
        headers: {
          'x-forwarded-for': '127.0.0.1',
          'x-mshop-client-ip': '203.0.113.10',
          'x-mshop-internal-secret': secretText,
        },
        body: { sessionHash },
      },
      dependencies(store),
    )
    const app = createApp(
      loadConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
      {
        logger: createLogger({ nodeEnv: 'test' }),
        registerRoutes(router) {
          registerLoginChallengeRoutes(router, dependencies(store))
        },
      },
    )
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/internal/login-sessions/discard`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mshop-client-ip': '203.0.113.10',
            'x-mshop-internal-secret': 'wrong-secret',
          },
          body: JSON.stringify({ sessionHash }),
        },
      )
      const body = await response.json()

      assert.equal(peer.status, 403)
      assert.deepEqual(peer.body, { code: 'forbidden' })
      assert.equal(response.status, 403)
      assert.deepEqual(body, { code: 'forbidden' })
      assert.equal(JSON.stringify(body).includes(sessionHash), false)
      assert.equal(store.calls.length, 0)
      assert.equal(store.rows.has(sessionHash), true)
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('rejects a malformed hash and hides a database failure', async () => {
    const store = database()
    const malformed = await handleDiscardLoginSession(
      {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          'x-mshop-client-ip': '203.0.113.10',
          'x-mshop-internal-secret': secretText,
        },
        body: { sessionHash, sessionId: 'raw-session' },
      },
      dependencies(store),
    )
    const unavailable = await handleDiscardLoginSession(
      {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          'x-mshop-client-ip': '203.0.113.10',
          'x-mshop-internal-secret': secretText,
        },
        body: { sessionHash },
      },
      {
        ...dependencies(store),
        database: {
          async query() {
            throw new Error(`delete failed ${sessionHash}`)
          },
        },
      },
    )

    assert.equal(malformed.status, 400)
    assert.deepEqual(malformed.body, { code: 'invalid_request' })
    assert.equal(unavailable.status, 503)
    assert.deepEqual(unavailable.body, { code: 'unavailable' })
    assert.equal(JSON.stringify(unavailable.body).includes(sessionHash), false)
    assert.equal(store.calls.length, 0)
  })
})
