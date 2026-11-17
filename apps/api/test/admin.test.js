import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requireAdmin } from '../src/auth/require-admin.js'
import { requireAuth } from '../src/auth/require-auth.js'
import { createApp } from '../src/app.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'

const userId = '22222222-2222-4222-8222-222222222222'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

function fakeDatabase(query) {
  const calls = []

  return {
    calls,
    async query(text, params) {
      calls.push({ text, params })
      return query(text, params)
    },
    async checkConnection() {
      return true
    },
  }
}

async function run(middleware, req) {
  let continued = false

  try {
    await middleware(req, {}, () => {
      continued = true
    })
  } catch (error) {
    return { continued, error }
  }

  return { continued }
}

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

describe('requireAdmin', () => {
  it('returns 401 when req.auth is missing and does not query the database', async () => {
    const database = fakeDatabase(async () => ({ rows: [{ '?column?': 1 }] }))
    const result = await run(requireAdmin(database), {})

    assert.equal(result.continued, false)
    assert.equal(result.error.status, 401)
    assert.equal(result.error.code, 'UNAUTHORIZED')
    assert.equal(result.error.message, 'Authentication required')
    assert.equal(database.calls.length, 0)
  })

  it('returns 401 when req.auth.userId is missing and does not query the database', async () => {
    const database = fakeDatabase(async () => ({ rows: [{ '?column?': 1 }] }))
    const result = await run(requireAdmin(database), {
      auth: { role: 'admin' },
    })

    assert.equal(result.error.status, 401)
    assert.equal(result.error.code, 'UNAUTHORIZED')
    assert.equal(database.calls.length, 0)
  })

  it('continues when the user has an admin row', async () => {
    const database = fakeDatabase(async () => ({ rows: [{ '?column?': 1 }] }))
    const result = await run(requireAdmin(database), {
      auth: { userId },
    })

    assert.equal(result.continued, true)
    assert.equal(result.error, undefined)
  })

  it('returns 403 when the user has no admin row', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const result = await run(requireAdmin(database), {
      auth: { userId },
    })

    assert.equal(result.continued, false)
    assert.equal(result.error.status, 403)
    assert.equal(result.error.code, 'FORBIDDEN')
    assert.equal(result.error.message, 'Insufficient permissions')
  })

  it('passes the user id as $1 and keeps it out of the SQL text', async () => {
    const database = fakeDatabase(async () => ({ rows: [{ '?column?': 1 }] }))
    await run(requireAdmin(database), { auth: { userId } })

    assert.equal(database.calls.length, 1)
    assert.match(database.calls[0].text, /\$1/)
    assert.equal(database.calls[0].text.includes(userId), false)
    assert.deepEqual(database.calls[0].params, [userId])
  })

  it('returns 503 without PostgreSQL details when the role query fails', async () => {
    const database = fakeDatabase(async () => {
      throw new Error(
        'password=secret SELECT public.user_roles connection postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      )
    })
    const result = await run(requireAdmin(database), { auth: { userId } })

    assert.equal(result.continued, false)
    assert.equal(result.error.status, 503)
    assert.equal(result.error.code, 'SERVICE_UNAVAILABLE')
    assert.equal(result.error.message, 'Service unavailable')
    assert.equal(result.error.logMessage, 'auth.admin_check_failed')
    assert.equal(result.error.message.includes('user_roles'), false)
    assert.equal(result.error.message.includes('password'), false)
    assert.equal(result.error.message.includes('postgres'), false)
  })

  it('ignores a role placed on the request and uses the database row', async () => {
    const denied = fakeDatabase(async () => ({ rows: [] }))
    const deniedResult = await run(requireAdmin(denied), {
      auth: { userId, role: 'admin' },
    })
    const allowed = fakeDatabase(async () => ({ rows: [{ '?column?': 1 }] }))
    const allowedResult = await run(requireAdmin(allowed), {
      auth: { userId },
    })

    assert.equal(deniedResult.error.status, 403)
    assert.equal(allowedResult.continued, true)
  })
})

describe('requireAuth then requireAdmin', () => {
  it('reaches the handler only after authentication and an admin row', async () => {
    const lines = []
    const logger = createLogger({
      nodeEnv: 'development',
      write(_level, line) {
        lines.push(line)
      },
    })
    const database = fakeDatabase(async () => ({ rows: [{ '?column?': 1 }] }))
    const accessTokens = {
      async verifyAccessToken() {
        return userId
      },
    }
    const app = createApp(config, {
      logger,
      database,
      accessTokens,
      registerRoutes(router) {
        router.get(
          '/api/v1/admin-probe',
          requireAuth(accessTokens),
          requireAdmin(database),
          (_req, res) => {
            res.status(200).json({ data: { ok: true }, meta: {} })
          },
        )
      },
    })
    const { server, baseUrl } = await listen(app)

    try {
      const health = await fetch(`${baseUrl}/api/v1/health`)
      const ready = await fetch(`${baseUrl}/api/v1/health/ready`)
      const missing = await fetch(`${baseUrl}/api/v1/admin-probe`)
      const healthBody = await health.json()
      const readyBody = await ready.json()
      const missingBody = await missing.json()

      assert.equal(health.status, 200)
      assert.deepEqual(healthBody, { data: { status: 'ok' }, meta: {} })
      assert.equal(ready.status, 200)
      assert.deepEqual(readyBody, { data: { status: 'ready' }, meta: {} })
      assert.equal(missing.status, 401)
      assert.equal(missingBody.error.code, 'UNAUTHORIZED')
      assert.equal(database.calls.length, 0)

      const allowed = await fetch(`${baseUrl}/api/v1/admin-probe`, {
        headers: { authorization: 'Bearer test-token' },
      })
      const allowedBody = await allowed.json()

      assert.equal(allowed.status, 200)
      assert.deepEqual(allowedBody, { data: { ok: true }, meta: {} })
      assert.equal(database.calls.length, 1)
      assert.deepEqual(database.calls[0].params, [userId])
    } finally {
      await close(server)
    }
  })

  it('hides a database failure from the admin check response and logs', async () => {
    const lines = []
    const logger = createLogger({
      nodeEnv: 'development',
      write(_level, line) {
        lines.push(line)
      },
    })
    const secret = 'relation "user_roles" does not exist at 127.0.0.1 password=secret'
    const database = fakeDatabase(async () => {
      throw new Error(secret)
    })
    const accessTokens = {
      async verifyAccessToken() {
        return userId
      },
    }
    const app = createApp(config, {
      logger,
      database,
      registerRoutes(router) {
        router.get(
          '/api/v1/admin-probe',
          requireAuth(accessTokens),
          requireAdmin(database),
          (_req, res) => {
            res.status(200).json({ data: { ok: true }, meta: {} })
          },
        )
      },
    })
    const { server, baseUrl } = await listen(app)

    try {
      const response = await fetch(`${baseUrl}/api/v1/admin-probe`, {
        headers: { authorization: 'Bearer test-token' },
      })
      const body = await response.json()
      const published = JSON.stringify({ body, lines })

      assert.equal(response.status, 503)
      assert.deepEqual(body, {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
          details: [],
        },
      })
      assert.equal(published.includes(secret), false)
      assert.equal(published.includes('user_roles'), false)
      assert.equal(published.includes('127.0.0.1'), false)
      assert.match(lines.join('\n'), /auth\.admin_check_failed/)
    } finally {
      await close(server)
    }
  })
})
