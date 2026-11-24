import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { inspectAndExtendAccountSession } from '../src/account-session/inspect-and-extend-account-session.js'
import {
  insertAccountSession,
  sha256Hex,
} from '../src/account-session/repository.js'
import { encryptToken } from '../src/account-session/token-cipher.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { holdIntegrationDatabase } from './integration-lock.js'
import { futureAccessToken } from './helpers/test-jwt.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const refreshToken = 'coordinated-refresh-token'

function localDatabaseUrl() {
  const configured = process.env.DATABASE_URL

  if (!configured) {
    return 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  }

  try {
    const url = new URL(configured)
    return LOCAL_HOSTS.has(url.hostname) ? configured : null
  } catch {
    return null
  }
}

const databaseUrl = localDatabaseUrl()
const probe = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
    })
  : null
let available = false

if (probe) {
  try {
    await probe.query('select 1')
    available = Boolean(
      (
        await probe.query(
          `select to_regclass('public.account_sessions') as sessions`,
        )
      ).rows[0].sessions,
    )
  } catch {
    available = false
  } finally {
    await probe.end()
  }
}

const skip = available ? false : 'local account session table is not available'
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      logger: createLogger({ nodeEnv: 'test' }),
    })
  : null
const key = randomBytes(32)
const userIds = []

function sessionRow(userId, overrides = {}) {
  const accessToken = futureAccessToken(3600, { sub: userId })
  const access = encryptToken(accessToken, key)
  const refresh = encryptToken(refreshToken, key)

  return {
    idHash: sha256Hex(randomUUID()),
    userId,
    accessToken,
    refreshState: 'ready',
    keyVersion: access.version,
    accessCiphertext: access.ciphertext,
    accessNonce: access.nonce,
    accessTag: access.tag,
    refreshCiphertext: refresh.ciphertext,
    refreshNonce: refresh.nonce,
    refreshTag: refresh.tag,
    csrfTokenHash: sha256Hex(randomUUID()),
    absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    idleExpiresAt: new Date(Date.now() + 60 * 1000),
    ...overrides,
  }
}

describe('inspect and extend account session storage', () => {
  after(async () => {
    if (!available) {
      return
    }

    if (userIds.length > 0) {
      await database.query(
        'delete from auth.users where id = any($1::uuid[])',
        [userIds],
      )
    }

    await database.close()
  })

  it(
    'extends a ready session and leaves a pending session unchanged',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = randomUUID()
      userIds.push(userId)
      await database.query('insert into auth.users (id) values ($1)', [userId])

      try {
        const ready = sessionRow(userId)
        const pending = sessionRow(userId, {
          refreshState: 'pending',
          refreshGeneration: randomUUID(),
          refreshStartedAt: new Date(),
          refreshTokenHash: sha256Hex('refresh-token'),
        })
        await insertAccountSession(database, ready)
        await insertAccountSession(database, pending)
        await database.query(
          `
            update public.account_sessions
            set refresh_started_at = now()
            where id_hash = $1
          `,
          [pending.idHash],
        )
        const beforePending = await database.query(
          `
            select idle_expires_at
            from public.account_sessions
            where id_hash = $1
          `,
          [pending.idHash],
        )
        const extended = await inspectAndExtendAccountSession({
          database,
          sessionHash: ready.idHash,
          key,
        })
        const pendingResult = await inspectAndExtendAccountSession({
          database,
          sessionHash: pending.idHash,
          key,
        })
        const afterReady = await database.query(
          `
            select idle_expires_at > now() + interval '29 minutes' as near_thirty,
                   idle_expires_at <= now() + interval '30 minutes' as within_cap,
                   refresh_state
            from public.account_sessions
            where id_hash = $1
          `,
          [ready.idHash],
        )
        const afterPending = await database.query(
          `
            select idle_expires_at, refresh_state
            from public.account_sessions
            where id_hash = $1
          `,
          [pending.idHash],
        )

        assert.deepEqual(extended, {
          status: 'ready',
          userId,
          accessToken: ready.accessToken,
          refreshToken,
          keyVersion: 1,
        })
        assert.equal(afterReady.rows[0].near_thirty, true)
        assert.equal(afterReady.rows[0].within_cap, true)
        assert.equal(afterReady.rows[0].refresh_state, 'ready')
        assert.deepEqual(pendingResult, { status: 'pending' })
        assert.equal(
          afterPending.rows[0].idle_expires_at.getTime(),
          beforePending.rows[0].idle_expires_at.getTime(),
        )
        assert.equal(afterPending.rows[0].refresh_state, 'pending')
      } finally {
        await release()
      }
    },
  )
})
