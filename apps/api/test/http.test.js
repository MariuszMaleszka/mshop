import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { HttpError } from '../src/http/errors.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

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

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function appWithRoutes(registerRoutes, lines) {
  const logger = createLogger({
    nodeEnv: 'development',
    write(_level, line) {
      lines.push(line)
    },
  })

  return createApp(config, { logger, registerRoutes })
}

describe('HTTP errors', () => {
  it('returns the status and body of an expected HTTP error', async () => {
    const lines = []
    const app = appWithRoutes((router) => {
      router.get('/expected', () => {
        throw new HttpError({
          status: 409,
          code: 'CONFLICT',
          message: 'Already exists',
          logMessage: 'password=hidden-secret postgres://user:pw@db.internal/shop',
        })
      })
    }, lines)
    const running = await listen(app)

    try {
      const response = await fetch(`${running.baseUrl}/expected`)
      const body = await response.json()

      assert.equal(response.status, 409)
      assert.deepEqual(body, {
        error: {
          code: 'CONFLICT',
          message: 'Already exists',
          details: [],
        },
      })
      assert.equal(lines.some((line) => line.includes('hidden-secret')), false)
      assert.equal(lines.some((line) => line.includes('postgres://')), false)
    } finally {
      await close(running.server)
    }
  })

  it('returns the not-found format', async () => {
    const app = createApp(config)
    const running = await listen(app)

    try {
      const response = await fetch(`${running.baseUrl}/missing`)
      const body = await response.json()

      assert.equal(response.status, 404)
      assert.deepEqual(body, {
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          details: [],
        },
      })
    } finally {
      await close(running.server)
    }
  })

  it('hides unexpected failures, SQL and stack traces', async () => {
    const lines = []
    const secret = 'super-secret-db-password'
    const app = appWithRoutes((router) => {
      router.get('/boom', () => {
        throw new Error(
          `select password from accounts; postgres://app:${secret}@db.internal/shop Bearer abc.def.ghi`,
        )
      })
    }, lines)
    const running = await listen(app)

    try {
      const response = await fetch(`${running.baseUrl}/boom`, {
        headers: {
          Authorization: 'Bearer client-token-value',
          Cookie: 'session=cookie-secret-value',
        },
      })
      const body = await response.json()
      const serialized = JSON.stringify(body)

      assert.equal(response.status, 500)
      assert.deepEqual(body, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: [],
        },
      })
      assert.equal(serialized.includes('select password'), false)
      assert.equal(serialized.includes(secret), false)
      assert.equal(serialized.includes('at '), false)
      assert.equal(lines.some((line) => line.includes(secret)), false)
      assert.equal(lines.some((line) => line.includes('postgres://')), false)
      assert.equal(lines.some((line) => line.includes('client-token-value')), false)
      assert.equal(lines.some((line) => line.includes('cookie-secret-value')), false)
    } finally {
      await close(running.server)
    }
  })

  it('returns a safe 400 for invalid JSON', async () => {
    const app = createApp(config)
    const running = await listen(app)

    try {
      const response = await fetch(`${running.baseUrl}/api/v1/health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
      const body = await response.json()

      assert.equal(response.status, 400)
      assert.deepEqual(body, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: [],
        },
      })
    } finally {
      await close(running.server)
    }
  })

  it('handles a rejected async route', async () => {
    const app = appWithRoutes((router) => {
      router.get('/async-fail', async () => {
        await Promise.resolve()
        throw new HttpError({
          status: 422,
          code: 'UNPROCESSABLE',
          message: 'Cannot process request',
        })
      })
    }, [])
    const running = await listen(app)

    try {
      const response = await fetch(`${running.baseUrl}/async-fail`)
      const body = await response.json()

      assert.equal(response.status, 422)
      assert.equal(body.error.code, 'UNPROCESSABLE')
    } finally {
      await close(running.server)
    }
  })

  it('assigns its own request id and keeps the query string out of logs', async () => {
    const lines = []
    const app = appWithRoutes(() => {}, lines)
    const running = await listen(app)

    try {
      const response = await fetch(
        `${running.baseUrl}/api/v1/health?token=query-secret-value`,
        { headers: { 'x-request-id': 'client-supplied-id' } },
      )
      const requestId = response.headers.get('x-request-id')
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.deepEqual(body, {
        data: { status: 'ok' },
        meta: {},
      })
      assert.match(requestId, /^[0-9a-f-]{36}$/)
      assert.notEqual(requestId, 'client-supplied-id')
      assert.equal(lines.some((line) => line.includes(requestId)), true)
      assert.equal(lines.some((line) => line.includes('/api/v1/health')), true)
      assert.equal(lines.some((line) => line.includes('query-secret-value')), false)
    } finally {
      await close(running.server)
    }
  })
})
