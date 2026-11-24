import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import {
  extendAccountSessionIdleExpiry,
  insertAccountSession,
  sha256Hex,
} from '../src/account-session/repository.js'
import { encryptToken } from '../src/account-session/token-cipher.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

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
  const access = encryptToken('access-token', key)
  const refresh = encryptToken('refresh-token', key)
  const soon = new Date(Date.now() + 60 * 1000)
  const later = new Date(Date.now() + 12 * 60 * 60 * 1000)

  return {
    idHash: sha256Hex(randomUUID()),
    userId,
    refreshState: 'ready',
    keyVersion: access.version,
    accessCiphertext: access.ciphertext,
    accessNonce: access.nonce,
    accessTag: access.tag,
    refreshCiphertext: refresh.ciphertext,
    refreshNonce: refresh.nonce,
    refreshTag: refresh.tag,
    csrfTokenHash: sha256Hex(randomUUID()),
    absoluteExpiresAt: later,
    idleExpiresAt: soon,
    ...overrides,
  }
}

async function insertUser() {
  const userId = randomUUID()
  await database.query('insert into auth.users (id) values ($1)', [userId])
  userIds.push(userId)
  return userId
}

async function readRow(idHash) {
  const result = await database.query(
    `
      select user_id, refresh_state, refresh_generation, refresh_started_at,
             refresh_token_hash, key_version, access_ciphertext, csrf_token_hash,
             absolute_expires_at, idle_expires_at, updated_at,
             idle_expires_at <= now() + interval '30 minutes' as within_cap,
             idle_expires_at > now() + interval '29 minutes' as near_thirty,
             idle_expires_at = absolute_expires_at as capped_by_absolute
      from public.account_sessions
      where id_hash = $1
    `,
    [idHash],
  )
  return result.rows[0]
}

describe('extend account session idle expiry', () => {
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
    'extends only a live ready session and keeps the other fields',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = await insertUser()

      try {
        const ready = sessionRow(userId)
        const capped = sessionRow(userId)
        const idleExpired = sessionRow(userId)
        const absoluteExpired = sessionRow(userId)
        const pending = sessionRow(userId, {
          refreshState: 'pending',
          refreshGeneration: randomUUID(),
          refreshStartedAt: new Date(),
          refreshTokenHash: sha256Hex('refresh-token'),
        })
        const unknown = sessionRow(userId, {
          refreshState: 'unknown',
          accessCiphertext: null,
          accessNonce: null,
          accessTag: null,
          refreshCiphertext: null,
          refreshNonce: null,
          refreshTag: null,
        })
        const held = sessionRow(userId)

        for (const session of [
          ready,
          capped,
          idleExpired,
          absoluteExpired,
          pending,
          unknown,
          held,
        ]) {
          await insertAccountSession(database, session)
        }

        await database.query(
          `
            update public.account_sessions
            set absolute_expires_at = now() + interval '10 minutes',
                idle_expires_at = now() + interval '1 minute'
            where id_hash = $1
          `,
          [capped.idHash],
        )
        await database.query(
          `
            update public.account_sessions
            set created_at = now() - interval '2 hours',
                idle_expires_at = now() - interval '1 minute',
                absolute_expires_at = now() + interval '1 hour'
            where id_hash = $1
          `,
          [idleExpired.idHash],
        )
        await database.query(
          `
            update public.account_sessions
            set created_at = now() - interval '13 hours',
                idle_expires_at = now() - interval '2 hours',
                absolute_expires_at = now() - interval '1 minute'
            where id_hash = $1
          `,
          [absoluteExpired.idHash],
        )
        await database.query(
          `
            update public.account_sessions
            set absolute_expires_at = now() + interval '2 hours',
                idle_expires_at = now() + interval '40 minutes'
            where id_hash = $1
          `,
          [held.idHash],
        )

        const before = await readRow(ready.idHash)
        const beforeHeld = await readRow(held.idHash)
        const beforeIdle = await readRow(idleExpired.idHash)
        const beforeAbsolute = await readRow(absoluteExpired.idHash)
        const beforePending = await readRow(pending.idHash)
        const beforeUnknown = await readRow(unknown.idHash)
        const extended = await extendAccountSessionIdleExpiry(database, {
          idHash: ready.idHash,
        })
        const parallel = await Promise.all([
          extendAccountSessionIdleExpiry(database, { idHash: ready.idHash }),
          extendAccountSessionIdleExpiry(database, { idHash: ready.idHash }),
        ])
        const cappedCount = await extendAccountSessionIdleExpiry(database, {
          idHash: capped.idHash,
        })
        const idleCount = await extendAccountSessionIdleExpiry(database, {
          idHash: idleExpired.idHash,
        })
        const absoluteCount = await extendAccountSessionIdleExpiry(database, {
          idHash: absoluteExpired.idHash,
        })
        const pendingCount = await extendAccountSessionIdleExpiry(database, {
          idHash: pending.idHash,
        })
        const unknownCount = await extendAccountSessionIdleExpiry(database, {
          idHash: unknown.idHash,
        })
        const heldCount = await extendAccountSessionIdleExpiry(database, {
          idHash: held.idHash,
        })
        const after = await readRow(ready.idHash)
        const afterHeld = await readRow(held.idHash)
        const afterIdle = await readRow(idleExpired.idHash)
        const afterAbsolute = await readRow(absoluteExpired.idHash)
        const afterPending = await readRow(pending.idHash)
        const afterUnknown = await readRow(unknown.idHash)
        const afterCapped = await readRow(capped.idHash)

        assert.equal(extended, 1)
        assert.deepEqual(parallel, [1, 1])
        assert.equal(after.near_thirty, true)
        assert.equal(after.within_cap, true)
        assert.equal(after.user_id, before.user_id)
        assert.equal(after.refresh_state, 'ready')
        assert.equal(after.key_version, before.key_version)
        assert.equal(after.csrf_token_hash, before.csrf_token_hash)
        assert.equal(
          after.access_ciphertext.equals(before.access_ciphertext),
          true,
        )
        assert.equal(
          after.absolute_expires_at.getTime(),
          before.absolute_expires_at.getTime(),
        )
        assert.equal(after.updated_at > before.updated_at, true)
        assert.equal(cappedCount, 1)
        assert.equal(afterCapped.capped_by_absolute, true)
        assert.equal(idleCount, 0)
        assert.equal(
          afterIdle.idle_expires_at.getTime(),
          beforeIdle.idle_expires_at.getTime(),
        )
        assert.equal(absoluteCount, 0)
        assert.equal(
          afterAbsolute.absolute_expires_at.getTime(),
          beforeAbsolute.absolute_expires_at.getTime(),
        )
        assert.equal(pendingCount, 0)
        assert.equal(afterPending.refresh_state, 'pending')
        assert.equal(
          afterPending.idle_expires_at.getTime(),
          beforePending.idle_expires_at.getTime(),
        )
        assert.equal(unknownCount, 0)
        assert.equal(afterUnknown.refresh_state, 'unknown')
        assert.equal(
          afterUnknown.idle_expires_at.getTime(),
          beforeUnknown.idle_expires_at.getTime(),
        )
        assert.equal(heldCount, 1)
        assert.equal(
          afterHeld.idle_expires_at.getTime(),
          beforeHeld.idle_expires_at.getTime(),
        )
      } finally {
        await release()
      }
    },
  )
})
