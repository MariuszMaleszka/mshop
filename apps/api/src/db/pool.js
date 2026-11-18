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
      async withTransaction() {
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
      return runQuery(pool, text, params)
    },

    async withTransaction(work) {
      if (typeof work !== 'function') {
        throw new TypeError('Transaction work is required')
      }

      const client = await pool.connect()

      try {
        await client.query('BEGIN')

        try {
          const result = await work({
            query(text, params = []) {
              return runQuery(client, text, params)
            },
          })
          await client.query('COMMIT')
          return result
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // The caller receives the original transaction error.
          }

          throw error
        }
      } finally {
        client.release()
      }
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

function runQuery(target, text, params) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('Query text is required')
  }

  if (!Array.isArray(params)) {
    throw new TypeError('Query parameters must be an array')
  }

  return target.query(text, params)
}
