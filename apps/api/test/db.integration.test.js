import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

function localDatabaseUrl() {
  const configured = process.env.DATABASE_URL

  if (configured) {
    try {
      const url = new URL(configured)

      if (LOCAL_HOSTS.has(url.hostname)) {
        return configured
      }
    } catch {
      return null
    }

    return null
  }

  return 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
}

const logger = createLogger({ nodeEnv: 'test' })
const databaseUrl = localDatabaseUrl()
const database = databaseUrl
  ? createDatabase({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      logger,
    })
  : null

let available = false

if (database) {
  try {
    available = await database.checkConnection()
  } catch {
    available = false
  }
}

if (!available) {
  await database?.close()
}

const skip = available ? false : 'local database is not available'

describe('PostgreSQL integration', () => {
  after(async () => {
    if (available) {
      await database.close()
    }
  })

  it('runs a parameterized query', { skip }, async () => {
    const result = await database.query('select $1::int as value', [7])

    assert.equal(Number(result.rows[0].value), 7)
  })

  it('answers ready when the database accepts a connection', { skip }, async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
    })
    const app = createApp(config, { database })
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })

    try {
      const address = server.address()
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health/ready`)
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.deepEqual(body, {
        data: { status: 'ready' },
        meta: {},
      })
    } finally {
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
  })
})
