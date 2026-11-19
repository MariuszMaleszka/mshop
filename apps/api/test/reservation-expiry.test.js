import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { createDatabase, SessionLockTimeoutError } from '../src/db/pool.js'
import {
  EXPIRY_ATTEMPT_LIMIT,
  runExpiryPass,
} from '../src/reservation-expiry/expire.js'
import { startReservationExpiryWorker } from '../src/reservation-expiry/worker.js'

const connectionString =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

describe('session lock timeout', () => {
  it('keeps the blocking lock when no timeout is given', async () => {
    const queries = []
    let worked = false
    const client = fakeClient(queries, {
      async query(text, params) {
        queries.push({ text, params })
        if (text.includes('pg_advisory_unlock')) {
          return { rows: [{ unlocked: true }] }
        }
        return { rows: [{ locked: true }] }
      },
    })
    const database = databaseWith(client)

    await database.withSessionLock(71003, 7, async () => {
      worked = true
    })

    assert.equal(worked, true)
    assert.equal(
      sql(queries).some((text) => text.includes('pg_try_advisory_lock')),
      false,
    )
    assert.equal(
      sql(queries).some((text) => text.includes('pg_advisory_lock(')),
      true,
    )
    assert.equal(client.releaseErrors.length, 1)
    assert.equal(client.releaseErrors[0], undefined)
  })

  it('does not call work when the timed lock is not acquired', async () => {
    const queries = []
    let worked = false
    const client = fakeClient(queries, {
      async query(text, params) {
        queries.push({ text, params })
        return { rows: [{ locked: false }] }
      },
    })
    const database = databaseWith(client)

    await assert.rejects(
      () =>
        database.withSessionLock(
          71003,
          7,
          async () => {
            worked = true
          },
          { timeoutMs: 0, now: () => 0 },
        ),
      SessionLockTimeoutError,
    )

    assert.equal(worked, false)
    assert.equal(
      sql(queries).some((text) => text.includes('pg_try_advisory_lock')),
      false,
    )
    assert.equal(
      sql(queries).some((text) => text.includes('pg_advisory_unlock')),
      false,
    )
    assert.equal(client.releaseErrors.length, 1)
    assert.equal(client.releaseErrors[0], undefined)
  })

  it('does not try again after the monotonic deadline', async () => {
    let now = 0
    const queries = []
    const sleeps = []
    let worked = false
    const client = fakeClient(queries, {
      async query(text, params) {
        queries.push({ text, params })
        if (text.includes('pg_try_advisory_lock') && now >= 100) {
          throw new Error('attempt after deadline')
        }
        return { rows: [{ locked: false }] }
      },
    })
    const database = databaseWith(client)

    await assert.rejects(
      () =>
        database.withSessionLock(
          71003,
          7,
          async () => {
            worked = true
          },
          {
            timeoutMs: 100,
            now: () => now,
            sleep(ms) {
              assert.ok(ms <= 100 - now)
              sleeps.push(ms)
              now += ms
            },
          },
        ),
      SessionLockTimeoutError,
    )

    assert.equal(worked, false)
    assert.deepEqual(sleeps, [50, 50])
    assert.equal(
      sql(queries).filter((text) => text.includes('pg_try_advisory_lock'))
        .length,
      2,
    )
    assert.equal(
      sql(queries).some((text) => text.includes('pg_advisory_unlock')),
      false,
    )
    assert.equal(client.releaseErrors[0], undefined)
  })

  it('does not extend the timeout when the wall clock moves backward', async () => {
    let now = 0
    let wall = 5000
    const originalNow = Date.now
    const queries = []
    const client = fakeClient(queries, {
      async query(text, params) {
        queries.push({ text, params })
        if (
          text.includes('pg_try_advisory_lock') &&
          sql(queries).filter((entry) => entry.includes('pg_try_advisory_lock'))
            .length > 2
        ) {
          throw new Error('attempt after deadline')
        }
        return { rows: [{ locked: false }] }
      },
    })
    const database = databaseWith(client)
    Date.now = () => wall

    try {
      await assert.rejects(
        () =>
          database.withSessionLock(
            71003,
            7,
            async () => {
              throw new Error('work')
            },
            {
              timeoutMs: 80,
              now: () => now,
              sleep(ms) {
                assert.ok(ms <= 80 - now)
                wall -= 120000
                now += ms
              },
            },
          ),
        SessionLockTimeoutError,
      )
    } finally {
      Date.now = originalNow
    }

    assert.ok(wall < 5000)
    assert.equal(
      sql(queries).filter((text) => text.includes('pg_try_advisory_lock'))
        .length,
      2,
    )
    assert.equal(
      sql(queries).some((text) => text.includes('pg_advisory_unlock')),
      false,
    )
    assert.equal(client.releaseErrors[0], undefined)
  })

  it('destroys the connection when unlock returns false', async () => {
    const client = fakeClient([], {
      async query(text) {
        if (text.includes('pg_advisory_unlock')) {
          return { rows: [{ unlocked: false }] }
        }
        return { rows: [{ locked: true }] }
      },
    })
    const database = databaseWith(client)

    await database.withSessionLock(71003, 7, async () => 'done')

    assert.equal(client.releaseErrors.length, 1)
    assert.equal(client.releaseErrors[0] instanceof Error, true)
    assert.equal(client.releaseErrors[0].message, 'advisory unlock failed')
  })

  it('keeps both the unlock failure and the work failure', async () => {
    const workError = new Error('work failed')
    const client = fakeClient([], {
      async query(text) {
        if (text.includes('pg_advisory_unlock')) {
          return { rows: [{ unlocked: false }] }
        }
        return { rows: [{ locked: true }] }
      },
    })
    const database = databaseWith(client)

    await assert.rejects(
      () =>
        database.withSessionLock(71003, 7, async () => {
          throw workError
        }),
      (error) => {
        assert.equal(error.message, 'advisory unlock failed')
        assert.equal(error.cause, workError)
        assert.equal(error.unlockError instanceof Error, true)
        assert.equal(client.releaseErrors[0], error)
        return true
      },
    )
  })

  it('destroys the connection when unlocking fails', async () => {
    const client = fakeClient([], {
      async query(text) {
        if (text.includes('pg_advisory_unlock')) {
          throw new Error('unlock failed')
        }
        return { rows: [] }
      },
    })
    const database = databaseWith(client)

    await database.withSessionLock(71003, 7, async () => 'done')

    assert.equal(client.releaseErrors.length, 1)
    assert.equal(client.releaseErrors[0] instanceof Error, true)
  })
})

describe('reservation expiry pass limits', () => {
  it('stops after 200 attempts and keeps a later order for the next pass', async () => {
    let reads = 0
    const database = {
      async query(text) {
        if (text.includes('min(expires_at)')) {
          reads += 1
          return {
            rows: [
              {
                order_id: randomUUID(),
                oldest_expires_at: new Date('2026-01-01T00:00:00.000Z'),
              },
            ],
          }
        }

        if (text.includes('FROM public.payments')) {
          return { rows: [] }
        }

        throw new Error('unexpected query')
      },
      async withSessionLock() {
        throw new Error('lock')
      },
    }
    const messages = []
    const stats = await runExpiryPass(database, {
      logger: {
        info(message, fields) {
          messages.push({ message, fields })
        },
        error(message) {
          messages.push({ message })
        },
      },
    })

    assert.equal(EXPIRY_ATTEMPT_LIMIT, 200)
    assert.equal(stats.attempts, 200)
    assert.equal(stats.transactions, 0)
    assert.equal(reads, 200)
    assert.equal(
      messages.some((entry) => String(entry.fields?.detail).includes('SELECT')),
      false,
    )
    assert.equal(
      messages.some((entry) => entry.message.includes('token')),
      false,
    )
  })

  it('does not start a second pass while one is running', async () => {
    let active = 0
    let maxActive = 0
    const database = {
      async close() {},
    }
    const worker = startReservationExpiryWorker({
      database,
      intervalMs: 5,
      closeDatabase: true,
      async runPass() {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 30))
        active -= 1
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 40))
    worker.requestStop()
    await worker.finished

    assert.equal(maxActive, 1)
  })
})

function sql(queries) {
  return queries.flatMap((query) =>
    typeof query.text === 'string' ? [query.text] : [],
  )
}

function databaseWith(client) {
  return createDatabase({
    connectionString,
    createPool() {
      return {
        on() {},
        async end() {},
        async connect() {
          return client
        },
        async query() {
          return { rows: [] }
        },
      }
    },
  })
}

function fakeClient(queries, implementation) {
  return {
    releaseErrors: [],
    query: implementation.query,
    release(error) {
      this.releaseErrors.push(error)
      queries.push({ released: true })
    },
  }
}
