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
      async withSessionLock() {
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
        return await runTransaction(client, work)
      } finally {
        client.release()
      }
    },

    async withSessionLock(namespace, key, work) {
      if (typeof work !== 'function') {
        throw new TypeError('Session lock work is required')
      }

      assertLockPart(namespace)
      assertLockPart(key)
      const client = await pool.connect()
      let locked = false

      try {
        await client.query(
          'SELECT pg_advisory_lock($1::integer, $2::integer)',
          [namespace, key],
        )
        locked = true
        return await work({
          query(text, params = []) {
            return runQuery(client, text, params)
          },
          transaction(nested) {
            return runTransaction(client, nested)
          },
        })
      } finally {
        let unlockFailed = false

        if (locked) {
          try {
            await client.query(
              'SELECT pg_advisory_unlock($1::integer, $2::integer)',
              [namespace, key],
            )
          } catch {
            unlockFailed = true
          }
        }

        client.release(
          unlockFailed ? new Error('advisory unlock failed') : undefined,
        )
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

async function runTransaction(client, work) {
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
}

function assertLockPart(value) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new TypeError('Invalid advisory lock key')
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
