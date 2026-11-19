import { performance } from 'node:perf_hooks'
import pg from 'pg'

const { Pool } = pg
const LOCK_RETRY_MS = 50

export class SessionLockTimeoutError extends Error {
  constructor() {
    super('Session lock timed out')
    this.name = 'SessionLockTimeoutError'
    this.code = 'LOCK_TIMEOUT'
  }
}

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

    async withSessionLock(namespace, key, work, options) {
      if (typeof work !== 'function') {
        throw new TypeError('Session lock work is required')
      }

      assertLockPart(namespace)
      assertLockPart(key)
      const timeoutMs = readLockTimeout(options)
      const client = await pool.connect()
      let locked = false
      let workError
      let result

      try {
        await acquireSessionLock(client, namespace, key, timeoutMs, options)
        locked = true
        result = await work({
          query(text, params = []) {
            return runQuery(client, text, params)
          },
          transaction(nested) {
            return runTransaction(client, nested)
          },
        })
      } catch (error) {
        workError = error
      }

      const unlockError = locked
        ? await unlockSessionLock(client, namespace, key)
        : undefined

      if (unlockError && workError) {
        const surfaced = new Error('advisory unlock failed', {
          cause: workError,
        })
        surfaced.unlockError = unlockError
        client.release(surfaced)
        throw surfaced
      }

      client.release(unlockError)

      if (workError) {
        throw workError
      }

      return result
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

function readLockTimeout(options) {
  if (options === undefined || options === null) {
    return undefined
  }

  if (options.timeoutMs === undefined) {
    return undefined
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0) {
    throw new TypeError('Session lock timeout must be a non-negative integer')
  }

  return options.timeoutMs
}

async function acquireSessionLock(client, namespace, key, timeoutMs, options) {
  if (timeoutMs === undefined) {
    await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [
      namespace,
      key,
    ])
    return
  }

  const now = readMonotonicClock(options)
  const sleep = readSleep(options)
  const deadline = now() + timeoutMs

  for (;;) {
    if (deadline - now() <= 0) {
      throw new SessionLockTimeoutError()
    }

    const result = await client.query(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked',
      [namespace, key],
    )

    if (result.rows[0]?.locked === true) {
      return
    }

    const remaining = deadline - now()

    if (remaining <= 0) {
      throw new SessionLockTimeoutError()
    }

    await sleep(Math.min(LOCK_RETRY_MS, remaining))
  }
}

async function unlockSessionLock(client, namespace, key) {
  try {
    const result = await client.query(
      'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked',
      [namespace, key],
    )

    if (result.rows[0]?.unlocked === true) {
      return undefined
    }
  } catch (error) {
    return new Error('advisory unlock failed', {
      cause: error instanceof Error ? error : undefined,
    })
  }

  return new Error('advisory unlock failed')
}

function readMonotonicClock(options) {
  if (typeof options?.now === 'function') {
    return options.now
  }

  return () => performance.now()
}

function readSleep(options) {
  if (typeof options?.sleep === 'function') {
    return options.sleep
  }

  return delay
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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
