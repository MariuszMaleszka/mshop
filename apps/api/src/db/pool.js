import pg from 'pg'

const { Pool } = pg

function defaultCreatePool(options) {
  return new Pool(options)
}

export function createDatabase({
  connectionString = null,
  max = 10,
  connectionTimeoutMs = 5000,
  idleTimeoutMs = 10000,
  logger,
  createPool = defaultCreatePool,
} = {}) {
  if (!connectionString) {
    return {
      async query() {
        throw new Error('Database is not configured')
      },
      async checkConnection() {
        return false
      },
      async close() {},
    }
  }

  const pool = createPool({
    connectionString,
    max,
    connectionTimeoutMillis: connectionTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
  })

  pool.on('error', () => {
    logger?.error('database.pool')
  })

  let closed = false

  return {
    async query(text, params = []) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new TypeError('Query text is required')
      }

      if (!Array.isArray(params)) {
        throw new TypeError('Query parameters must be an array')
      }

      return pool.query(text, params)
    },

    async checkConnection() {
      try {
        const result = await pool.query('SELECT 1 AS ok')
        return Number(result.rows[0]?.ok) === 1
      } catch {
        logger?.error('database.check_failed')
        return false
      }
    },

    async close() {
      if (closed) {
        return
      }

      closed = true
      await pool.end()
    },
  }
}
