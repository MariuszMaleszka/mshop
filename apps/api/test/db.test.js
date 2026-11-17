import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'
import { createShutdown } from '../src/shutdown.js'

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

function capturingLogger() {
  const lines = []
  const logger = createLogger({
    nodeEnv: 'development',
    write(_level, line) {
      lines.push(line)
    },
  })

  return { logger, lines }
}

function fakePool() {
  const handlers = {}

  return {
    queries: [],
    ended: 0,
    options: null,
    on(event, handler) {
      handlers[event] = handler
    },
    emitError(error) {
      handlers.error(error)
    },
    async query(text, params) {
      this.queries.push({ text, params })

      if (String(text).includes('THROW')) {
        throw new Error('postgres://app:secret-password@db.internal/shop')
      }

      return { rows: [{ ok: 1, value: params?.[0] }] }
    },
    async end() {
      this.ended += 1
    },
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` })
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

describe('database pool', () => {
  it('runs a parameterized query through one pool', async () => {
    const pool = fakePool()
    const database = createDatabase({
      connectionString:
        'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 2000,
      createPool(options) {
        pool.options = options
        return pool
      },
    })

    const result = await database.query('select $1::int as value', [7])

    assert.equal(result.rows[0].value, 7)
    assert.deepEqual(pool.queries[0], {
      text: 'select $1::int as value',
      params: [7],
    })
    assert.equal(pool.options.max, 4)
    assert.equal(pool.options.connectionTimeoutMillis, 1000)
    assert.equal(pool.options.idleTimeoutMillis, 2000)
  })

  it('reports availability without exposing a connection failure', async () => {
    const { logger, lines } = capturingLogger()
    const pool = fakePool()
    const database = createDatabase({
      connectionString:
        'postgresql://app:secret-password@127.0.0.1:54322/postgres',
      logger,
      createPool() {
        return pool
      },
    })

    assert.equal(await database.checkConnection(), true)
    pool.queries.length = 0
    pool.query = async function query() {
      throw new Error(
        'connect ECONNREFUSED 127.0.0.1:54322 password=secret-password',
      )
    }

    assert.equal(await database.checkConnection(), false)
    pool.emitError(new Error('postgres://app:secret-password@db.internal/shop'))

    const log = lines.join('\n')
    assert.match(log, /database.check_failed/)
    assert.match(log, /database.pool/)
    assert.equal(log.includes('secret-password'), false)
    assert.equal(log.includes('ECONNREFUSED'), false)
    assert.equal(log.includes('postgres://'), false)
  })

  it('closes the pool once', async () => {
    const pool = fakePool()
    const database = createDatabase({
      connectionString:
        'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      createPool() {
        return pool
      },
    })

    await database.close()
    await database.close()

    assert.equal(pool.ended, 1)
  })

  it('returns 503 without PostgreSQL details when the database is unavailable', async () => {
    const app = createApp(config, {
      database: {
        async checkConnection() {
          return false
        },
        async close() {},
      },
    })
    const running = await listen(app)

    try {
      const response = await fetch(`${running.baseUrl}/api/v1/health/ready`)
      const body = await response.json()
      const serialized = JSON.stringify(body)

      assert.equal(response.status, 503)
      assert.deepEqual(body, {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
          details: [],
        },
      })
      assert.equal(serialized.includes('ECONNREFUSED'), false)
      assert.equal(serialized.includes('postgres'), false)
      assert.equal(serialized.includes('password'), false)
    } finally {
      await close(running.server)
    }
  })

  it('keeps the process health response unchanged', async () => {
    const app = createApp(config, {
      database: {
        async checkConnection() {
          return false
        },
        async close() {},
      },
    })
    const running = await listen(app)

    try {
      const response = await fetch(`${running.baseUrl}/api/v1/health`)
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.deepEqual(body, {
        data: { status: 'ok' },
        meta: {},
      })
    } finally {
      await close(running.server)
    }
  })
})

describe('shutdown', () => {
  it('closes the server and the pool once', async () => {
    const { logger } = capturingLogger()
    let serverClosed = 0
    let databaseClosed = 0
    const codes = []
    const shutdown = createShutdown({
      server: {
        close(callback) {
          serverClosed += 1
          callback()
        },
      },
      database: {
        async close() {
          databaseClosed += 1
        },
      },
      logger,
      exit(code) {
        codes.push(code)
      },
    })

    await shutdown()
    await shutdown()

    assert.equal(serverClosed, 1)
    assert.equal(databaseClosed, 1)
    assert.deepEqual(codes, [0])
  })

  it('logs a safe message when closing the pool fails', async () => {
    const { logger, lines } = capturingLogger()
    const codes = []
    const shutdown = createShutdown({
      server: {
        close(callback) {
          callback()
        },
      },
      database: {
        async close() {
          throw new Error('postgres://app:secret-password@db.internal/shop')
        },
      },
      logger,
      exit(code) {
        codes.push(code)
      },
    })

    await shutdown()

    assert.deepEqual(codes, [1])
    assert.match(lines.join('\n'), /shutdown.failed/)
    assert.equal(lines.join('\n').includes('secret-password'), false)
  })
})
