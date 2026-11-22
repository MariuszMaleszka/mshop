import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { registerLoginChallengeRoutes } from '../src/account-session/routes.js'
import { issueLoginChallenge } from '../src/account-session/issue-challenge.js'
import {
  createLoginChallengeValue,
  isLoginChallengeValue,
  sha256Hex,
} from '../src/account-session/repository.js'
import { createApp } from '../src/app.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'

const secret = randomBytes(32)
const secretText = secret.toString('base64')
const clientIp = '203.0.113.10'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

function trustedRequest(overrides = {}) {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'x-forwarded-for': '198.51.100.20',
      'x-mshop-client-ip': clientIp,
      'x-mshop-internal-secret': secretText,
      ...overrides.headers,
    },
    ...overrides,
  }
}

function dependencies(overrides = {}) {
  return {
    database: { async query() {} },
    bffInternalSecret: secret,
    bffTrustedPeers: ['127.0.0.1', '::1'],
    rateLimitHmacKey: randomBytes(32),
    ...overrides,
  }
}

describe('issueLoginChallenge', () => {
  it('authenticates, limits, generates, stores, then returns the values', async () => {
    const steps = []
    const values = [createLoginChallengeValue(), createLoginChallengeValue()]
    let index = 0
    const result = await issueLoginChallenge(
      trustedRequest(),
      dependencies({
        async consumeRateLimit(_database, input) {
          steps.push(`limit:${input.ip}`)
          return { allowed: true }
        },
        createValue() {
          steps.push('value')
          const value = values[index]
          index += 1
          return value
        },
        async storeChallenge(_database, input) {
          steps.push('store')
          assert.deepEqual(input, {
            challengeId: values[0],
            csrfSecret: values[1],
          })
        },
      }),
    )

    assert.deepEqual(steps, [`limit:${clientIp}`, 'value', 'value', 'store'])
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, {
      challengeId: values[0],
      csrfSecret: values[1],
    })
    assert.notEqual(values[0], values[1])
    assert.equal(isLoginChallengeValue(values[0]), true)
    assert.equal(isLoginChallengeValue(values[1]), true)
    assert.equal(JSON.stringify(result.body).includes(secretText), false)
    assert.equal(JSON.stringify(result.body).includes(clientIp), false)
    assert.equal(
      JSON.stringify(result.body).includes(sha256Hex(values[0])),
      false,
    )
  })

  it('rejects an untrusted peer, a bad secret, and an empty allowlist first', async () => {
    const calls = []
    const deny = dependencies({
      async consumeRateLimit() {
        calls.push('limit')
      },
      createValue() {
        calls.push('value')
      },
      async storeChallenge() {
        calls.push('store')
      },
    })

    const untrusted = await issueLoginChallenge(
      trustedRequest({ socket: { remoteAddress: '192.0.2.20' } }),
      deny,
    )
    const wrongSecret = await issueLoginChallenge(
      trustedRequest({
        headers: {
          'x-mshop-internal-secret': randomBytes(32).toString('base64'),
        },
      }),
      deny,
    )
    const emptyList = await issueLoginChallenge(
      trustedRequest(),
      dependencies({ ...deny, bffTrustedPeers: [] }),
    )
    const missingSecret = await issueLoginChallenge(
      trustedRequest(),
      dependencies({ ...deny, bffInternalSecret: null }),
    )

    for (const result of [untrusted, wrongSecret, emptyList, missingSecret]) {
      assert.equal(result.status, 403)
      assert.deepEqual(result.body, { code: 'forbidden' })
      assert.equal(JSON.stringify(result.body).includes(secretText), false)
      assert.equal(
        JSON.stringify(result.body).includes('missing_config'),
        false,
      )
    }

    assert.deepEqual(calls, [])
  })

  it('does not generate a challenge when the limit or the limiter fails', async () => {
    let generated = false
    const limited = dependencies({
      async consumeRateLimit() {
        return { allowed: false }
      },
      createValue() {
        generated = true
        return createLoginChallengeValue()
      },
    })

    await assert.rejects(
      issueLoginChallenge(trustedRequest(), limited),
      (error) => {
        assert.equal(error.status, 429)
        assert.equal(error.code, 'RATE_LIMITED')
        assert.equal(error.message, 'Request rejected')
        return true
      },
    )
    assert.equal(generated, false)

    let queried = false
    await assert.rejects(
      issueLoginChallenge(
        trustedRequest(),
        dependencies({
          rateLimitHmacKey: null,
          database: {
            async query() {
              queried = true
            },
          },
          createValue() {
            generated = true
            return createLoginChallengeValue()
          },
        }),
      ),
      (error) => {
        assert.equal(error.status, 503)
        assert.equal(error.code, 'SERVICE_UNAVAILABLE')
        assert.equal(String(error).includes(secretText), false)
        return true
      },
    )
    assert.equal(queried, false)
    assert.equal(generated, false)
  })

  it('does not return values when the insert fails', async () => {
    const challengeId = createLoginChallengeValue()
    const csrfSecret = createLoginChallengeValue()
    const values = [challengeId, csrfSecret]

    await assert.rejects(
      issueLoginChallenge(
        trustedRequest(),
        dependencies({
          async consumeRateLimit() {
            return { allowed: true }
          },
          createValue() {
            return values.shift()
          },
          async storeChallenge() {
            throw new Error(`insert failed ${challengeId} ${csrfSecret}`)
          },
        }),
      ),
      (error) => {
        assert.equal(error.status, 503)
        assert.equal(error.message, 'Service unavailable')
        assert.equal(String(error).includes(challengeId), false)
        assert.equal(String(error).includes(csrfSecret), false)
        return true
      },
    )
  })
})

describe('login challenge route', () => {
  it('uses the verified client address and hides secrets in the log', async () => {
    const lines = []
    const seen = []
    const logger = createLogger({
      nodeEnv: 'development',
      write(_level, line) {
        lines.push(line)
      },
    })
    const app = createApp(config, {
      logger,
      registerRoutes(router) {
        registerLoginChallengeRoutes(
          router,
          dependencies({
            async consumeRateLimit(_database, input) {
              seen.push(input.ip)
              return { allowed: false }
            },
          }),
        )
      },
    })
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/internal/login-challenges`,
        {
          method: 'POST',
          headers: {
            'x-forwarded-for': '198.51.100.20',
            'x-mshop-client-ip': clientIp,
            'x-mshop-internal-secret': secretText,
          },
        },
      )
      const body = await response.json()

      assert.equal(response.status, 429)
      assert.equal(body.error.code, 'RATE_LIMITED')
      assert.deepEqual(seen, [clientIp])
      assert.equal(lines.join('\n').includes(secretText), false)
      assert.equal(lines.join('\n').includes(clientIp), false)
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
