import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { CompleteLoginError } from '../src/account-session/complete-login-attempt.js'
import { handleInternalLogin } from '../src/account-session/internal-login.js'
import { registerLoginChallengeRoutes } from '../src/account-session/routes.js'
import { createLoginChallengeValue } from '../src/account-session/repository.js'
import { createApp } from '../src/app.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'

const secret = randomBytes(32)
const secretText = secret.toString('base64')
const clientIp = '203.0.113.10'
const email = 'person@example.com'
const password = 'correct-horse-battery'
const challengeId = createLoginChallengeValue()
const csrfSecret = createLoginChallengeValue()
const sessionId = createLoginChallengeValue()
const sessionCsrf = createLoginChallengeValue()
const accessToken = 'access-token-value'
const refreshToken = 'refresh-token-value'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

function body(overrides = {}) {
  return {
    challengeId,
    csrfSecret,
    email,
    password,
    ...overrides,
  }
}

function dependencies(completeLogin) {
  return {
    database: { async query() {} },
    bffInternalSecret: secret,
    bffTrustedPeers: ['127.0.0.1', '::1'],
    rateLimitHmacKey: randomBytes(32),
    sessionTokenKey: randomBytes(32),
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseAnonKey: 'anon-key-value',
    completeLogin,
  }
}

async function listen(
  completeLogin,
  logger = createLogger({ nodeEnv: 'test' }),
) {
  const app = createApp(config, {
    logger,
    registerRoutes(router) {
      registerLoginChallengeRoutes(router, dependencies(completeLogin))
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

async function post(port, { headers = {}, payload = body(), raw } = {}) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/v1/internal/login`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mshop-client-ip': clientIp,
        'x-mshop-internal-secret': secretText,
        ...headers,
      },
      body: raw ?? JSON.stringify(payload),
    },
  )
  return { status: response.status, body: await response.json() }
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function hidden(value) {
  const visible = JSON.stringify(value)
  for (const secretValue of [
    email,
    password,
    challengeId,
    csrfSecret,
    accessToken,
    refreshToken,
    secretText,
  ]) {
    assert.equal(visible.includes(secretValue), false)
  }
}

describe('internal login route', () => {
  it('calls login once with the authenticated client address and returns only session secrets', async () => {
    const calls = []
    const lines = []
    const { server, port } = await listen(
      async (input) => {
        calls.push(input)
        return { sessionId, csrfSecret: sessionCsrf, accessToken, refreshToken }
      },
      createLogger({
        nodeEnv: 'development',
        write(_level, line) {
          lines.push(line)
        },
      }),
    )

    try {
      const response = await post(port, {
        headers: { 'x-forwarded-for': '198.51.100.20' },
      })

      assert.equal(response.status, 200)
      assert.deepEqual(response.body, {
        sessionId,
        csrfSecret: sessionCsrf,
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].clientIp, clientIp)
      assert.equal(calls[0].password, password)
      assert.equal(Object.hasOwn(calls[0], 'clientIp'), true)
      assert.equal(lines.join('\n').includes(password), false)
      assert.equal(lines.join('\n').includes(email), false)
      assert.equal(lines.join('\n').includes(accessToken), false)
    } finally {
      await close(server)
    }
  })

  it('rejects an untrusted peer and a bad internal secret before login', async () => {
    let called = false
    const completeLogin = async () => {
      called = true
      return { sessionId, csrfSecret: sessionCsrf }
    }
    const peer = await handleInternalLogin(
      {
        socket: { remoteAddress: '198.51.100.9' },
        headers: {
          'x-forwarded-for': '127.0.0.1',
          'x-mshop-client-ip': clientIp,
          'x-mshop-internal-secret': secretText,
        },
        body: body(),
      },
      dependencies(completeLogin),
    )
    const { server, port } = await listen(completeLogin)

    try {
      const denied = await fetch(
        `http://127.0.0.1:${port}/api/v1/internal/login`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mshop-client-ip': clientIp,
            'x-mshop-internal-secret': 'wrong-secret',
          },
          body: JSON.stringify(body()),
        },
      )
      const deniedBody = await denied.json()

      assert.equal(peer.status, 403)
      assert.deepEqual(peer.body, { code: 'forbidden' })
      assert.equal(denied.status, 403)
      assert.deepEqual(deniedBody, { code: 'forbidden' })
      assert.equal(called, false)
      hidden(peer.body)
      hidden(deniedBody)
    } finally {
      await close(server)
    }
  })

  it('rejects a malformed body before login', async () => {
    let called = false
    const { server, port } = await listen(async () => {
      called = true
    })
    const previousSessionHash = 'A'.repeat(64)

    try {
      const missing = await post(port, {
        payload: { challengeId, csrfSecret, email },
      })
      const wrongType = await post(port, {
        payload: body({ password: 12 }),
      })
      const badHash = await post(port, {
        payload: body({ previousSessionHash }),
      })
      const extra = await post(port, {
        payload: body({ clientIp: '198.51.100.8' }),
      })

      for (const response of [missing, wrongType, badHash, extra]) {
        assert.equal(response.status, 400)
        assert.deepEqual(response.body, { code: 'invalid_request' })
        hidden(response.body)
      }
      assert.equal(called, false)
    } finally {
      await close(server)
    }
  })

  it('maps login failures without returning their details', async () => {
    const cases = [
      ['invalid_challenge', 403, 'invalid_challenge'],
      ['rate_limited', 429, 'rate_limited'],
      ['invalid_credentials', 401, 'invalid_credentials'],
      ['unavailable', 503, 'unavailable'],
      ['invalid_response', 503, 'unavailable'],
      ['configuration', 503, 'unavailable'],
      ['session_failed', 503, 'unavailable'],
    ]
    const { server, port } = await listen(async () => {
      throw new CompleteLoginError(cases.shift()?.[0] ?? 'unavailable')
    })

    try {
      for (const [, status, code] of [
        ['invalid_challenge', 403, 'invalid_challenge'],
        ['rate_limited', 429, 'rate_limited'],
        ['invalid_credentials', 401, 'invalid_credentials'],
        ['unavailable', 503, 'unavailable'],
        ['invalid_response', 503, 'unavailable'],
        ['configuration', 503, 'unavailable'],
        ['session_failed', 503, 'unavailable'],
      ]) {
        const response = await post(port)
        assert.equal(response.status, status)
        assert.deepEqual(response.body, { code })
        hidden(response.body)
      }
    } finally {
      await close(server)
    }
  })

  it('hides an unexpected failure', async () => {
    const { server, port } = await listen(async () => {
      throw new Error(`database ${password} ${accessToken}`)
    })

    try {
      const response = await post(port)
      assert.equal(response.status, 500)
      assert.deepEqual(response.body, { code: 'internal_error' })
      hidden(response.body)
    } finally {
      await close(server)
    }
  })
})
