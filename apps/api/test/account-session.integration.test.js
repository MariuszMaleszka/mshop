import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import {
  AccountSessionWriteError,
  beginAccountSessionRefresh,
  consumeLoginChallenge,
  createReadyAccountSession,
  deleteAccountSession,
  findAccountSession,
  incrementAuthAttempt,
  insertAccountSession,
  createLoginChallenge,
  createLoginChallengeValue,
  insertLoginChallenge,
  markAccountSessionUnknown,
  markStalePendingUnknown,
  saveRefreshedSession,
  sha256Hex,
} from '../src/account-session/repository.js'
import {
  decryptToken,
  encryptToken,
} from '../src/account-session/token-cipher.js'
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
    const tables = await probe.query(
      `
        select to_regclass('public.account_sessions') as sessions,
               to_regclass('public.login_challenges') as challenges,
               to_regclass('public.auth_attempt_counters') as counters
      `,
    )
    available = Boolean(
      tables.rows[0].sessions &&
      tables.rows[0].challenges &&
      tables.rows[0].counters,
    )
  } catch {
    available = false
  } finally {
    await probe.end()
  }
}

const skip = available
  ? false
  : 'local account-session tables are not available'
const logger = createLogger({ nodeEnv: 'test' })
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      logger,
    })
  : null
const key = randomBytes(32)
const userIds = []

function seal(value) {
  return encryptToken(value, key)
}

function sessionRow(overrides = {}) {
  const access = seal('access-token')
  const refresh = seal('refresh-token')
  const now = Date.now()

  return {
    idHash: sha256Hex(randomUUID()),
    userId: overrides.userId,
    refreshState: 'ready',
    keyVersion: 1,
    accessCiphertext: access.ciphertext,
    accessNonce: access.nonce,
    accessTag: access.tag,
    refreshCiphertext: refresh.ciphertext,
    refreshNonce: refresh.nonce,
    refreshTag: refresh.tag,
    csrfTokenHash: sha256Hex(randomUUID()),
    absoluteExpiresAt: new Date(now + 12 * 60 * 60 * 1000),
    idleExpiresAt: new Date(now + 30 * 60 * 1000),
    ...overrides,
  }
}

async function insertUser() {
  const userId = randomUUID()
  await database.query('insert into auth.users (id) values ($1)', [userId])
  userIds.push(userId)
  return userId
}

describe('account session storage', () => {
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
    'stores a session, rejects a bad state, and deletes it',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = await insertUser()

      try {
        const session = sessionRow({ userId })
        await insertAccountSession(database, session)
        const stored = await findAccountSession(database, session.idHash)

        assert.equal(stored.user_id, userId)
        assert.equal(stored.refresh_state, 'ready')
        assert.equal(
          stored.access_ciphertext.equals(session.accessCiphertext),
          true,
        )
        assert.equal(await deleteAccountSession(database, session.idHash), 1)
        assert.equal(await findAccountSession(database, session.idHash), null)

        await assert.rejects(
          insertAccountSession(
            database,
            sessionRow({
              userId,
              refreshState: 'ready',
              accessCiphertext: null,
              accessNonce: null,
              accessTag: null,
            }),
          ),
          (error) =>
            error instanceof AccountSessionWriteError &&
            error.code === 'rejected',
        )
      } finally {
        await release()
      }
    },
  )

  it(
    'begins a pending refresh and rejects a late or mismatched save',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = await insertUser()

      try {
        const ready = sessionRow({ userId })
        await insertAccountSession(database, ready)
        const generation = randomUUID()
        const started = await beginAccountSessionRefresh(database, {
          idHash: ready.idHash,
          generation,
          refreshTokenHash: sha256Hex('refresh-token'),
        })
        assert.equal(started.csrf_token_hash, ready.csrfTokenHash)

        const pending = await findAccountSession(database, ready.idHash)
        assert.equal(pending.refresh_state, 'pending')
        assert.equal(pending.refresh_generation, generation)

        await database.query(
          `
            update public.account_sessions
            set refresh_started_at = now() - interval '20 seconds'
            where id_hash = $1
          `,
          [ready.idHash],
        )

        const late = await saveRefreshedSession(database, {
          idHash: ready.idHash,
          generation,
          session: {
            keyVersion: 1,
            accessCiphertext: ready.accessCiphertext,
            accessNonce: ready.accessNonce,
            accessTag: ready.accessTag,
            refreshCiphertext: ready.refreshCiphertext,
            refreshNonce: ready.refreshNonce,
            refreshTag: ready.refreshTag,
            csrfTokenHash: ready.csrfTokenHash,
          },
        })
        assert.equal(late, 0)

        const cleared = await markAccountSessionUnknown(database, {
          idHash: ready.idHash,
          generation,
        })
        assert.equal(cleared, 1)
        const unknown = await findAccountSession(database, ready.idHash)
        assert.equal(unknown.refresh_state, 'unknown')
        assert.equal(unknown.access_ciphertext, null)
        assert.equal(unknown.refresh_ciphertext, null)
      } finally {
        await release()
      }
    },
  )

  it('marks only stale pending rows as unknown', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const userId = await insertUser()

    try {
      const fresh = sessionRow({
        userId,
        refreshState: 'pending',
        refreshGeneration: randomUUID(),
        refreshStartedAt: new Date(),
        refreshTokenHash: sha256Hex('fresh-refresh'),
      })
      const stale = sessionRow({
        userId,
        refreshState: 'pending',
        refreshGeneration: randomUUID(),
        refreshStartedAt: new Date(Date.now() - 20_000),
        refreshTokenHash: sha256Hex('stale-refresh'),
      })
      await insertAccountSession(database, fresh)
      await insertAccountSession(database, stale)

      assert.equal(
        await markStalePendingUnknown(database, { idHash: fresh.idHash }),
        0,
      )
      assert.equal(
        await markStalePendingUnknown(database, { idHash: stale.idHash }),
        1,
      )

      const freshRow = await findAccountSession(database, fresh.idHash)
      const staleRow = await findAccountSession(database, stale.idHash)
      assert.equal(freshRow.refresh_state, 'pending')
      assert.equal(staleRow.refresh_state, 'unknown')
      assert.equal(staleRow.access_ciphertext, null)
    } finally {
      await release()
    }
  })

  it(
    'does not save tokens when the refresh generation differs',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = await insertUser()

      try {
        const generation = randomUUID()
        const pending = sessionRow({
          userId,
          refreshState: 'pending',
          refreshGeneration: generation,
          refreshStartedAt: new Date(),
          refreshTokenHash: sha256Hex('refresh-token'),
        })
        await insertAccountSession(database, pending)
        const replacement = seal('replacement-access')

        const changed = await saveRefreshedSession(database, {
          idHash: pending.idHash,
          generation: randomUUID(),
          session: {
            keyVersion: 1,
            accessCiphertext: replacement.ciphertext,
            accessNonce: replacement.nonce,
            accessTag: replacement.tag,
            refreshCiphertext: pending.refreshCiphertext,
            refreshNonce: pending.refreshNonce,
            refreshTag: pending.refreshTag,
            csrfTokenHash: pending.csrfTokenHash,
          },
        })
        const stored = await findAccountSession(database, pending.idHash)

        assert.equal(changed, 0)
        assert.equal(stored.refresh_state, 'pending')
        assert.equal(stored.refresh_generation, generation)
        assert.equal(
          stored.access_ciphertext.equals(pending.accessCiphertext),
          true,
        )
      } finally {
        await release()
      }
    },
  )

  it(
    'keeps the Express role and blocks Supabase API roles',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)

      try {
        const role = await database.query('select current_user as role')
        const expressRole = role.rows[0].role
        const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
        const tables = [
          'public.account_sessions',
          'public.login_challenges',
          'public.auth_attempt_counters',
        ]
        const blocked = ['anon', 'authenticated', 'service_role']

        for (const table of tables) {
          for (const privilege of privileges) {
            const allowed = await database.query(
              'select has_table_privilege($1, $2, $3) as allowed',
              [expressRole, table, privilege],
            )
            assert.equal(allowed.rows[0].allowed, true)

            for (const grantee of blocked) {
              const denied = await database.query(
                'select has_table_privilege($1, $2, $3) as allowed',
                [grantee, table, privilege],
              )
              assert.equal(denied.rows[0].allowed, false)
            }
          }
        }

        await assert.rejects(
          database.withTransaction(async (tx) => {
            await tx.query('set local role service_role')
            await tx.query('select 1 from public.account_sessions')
          }),
          (error) => error?.code === '42501',
        )
      } finally {
        await release()
      }
    },
  )

  it(
    'stores a ready session with database deadlines and replaces the previous hash',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = await insertUser()
      const previous = sessionRow({ userId })
      const accessToken = 'ready-access-token'
      const refreshToken = 'ready-refresh-token'

      try {
        await insertAccountSession(database, previous)
        const created = await createReadyAccountSession(database, {
          userId,
          accessToken,
          refreshToken,
          key,
          previousSessionHash: previous.idHash,
        })
        const stored = await database.query(
          `
            select id_hash,
                   csrf_token_hash,
                   refresh_state,
                   refresh_generation,
                   refresh_started_at,
                   refresh_token_hash,
                   key_version,
                   access_ciphertext,
                   access_nonce,
                   access_tag,
                   refresh_ciphertext,
                   refresh_nonce,
                   refresh_tag,
                   extract(epoch from (absolute_expires_at - created_at)) as absolute_seconds,
                   extract(epoch from (idle_expires_at - created_at)) as idle_seconds,
                   idle_expires_at <= absolute_expires_at as within_absolute
            from public.account_sessions
            where id_hash = $1
          `,
          [sha256Hex(created.sessionId)],
        )
        const row = stored.rows[0]
        const visible = JSON.stringify(row)

        assert.equal(await findAccountSession(database, previous.idHash), null)
        assert.equal(row.id_hash, sha256Hex(created.sessionId))
        assert.equal(row.csrf_token_hash, sha256Hex(created.csrfSecret))
        assert.equal(row.refresh_state, 'ready')
        assert.equal(row.refresh_generation, null)
        assert.equal(row.refresh_started_at, null)
        assert.equal(row.refresh_token_hash, null)
        assert.equal(Number(row.absolute_seconds), 12 * 60 * 60)
        assert.equal(Number(row.idle_seconds), 30 * 60)
        assert.equal(row.within_absolute, true)
        assert.equal(visible.includes(created.sessionId), false)
        assert.equal(visible.includes(created.csrfSecret), false)
        assert.equal(visible.includes(accessToken), false)
        assert.equal(visible.includes(refreshToken), false)
        assert.equal(
          decryptToken(
            {
              ciphertext: row.access_ciphertext,
              nonce: row.access_nonce,
              tag: row.access_tag,
              version: row.key_version,
            },
            key,
          ),
          accessToken,
        )
        assert.equal(
          decryptToken(
            {
              ciphertext: row.refresh_ciphertext,
              nonce: row.refresh_nonce,
              tag: row.refresh_tag,
              version: row.key_version,
            },
            key,
          ),
          refreshToken,
        )

        const missingUser = randomUUID()
        const kept = await createReadyAccountSession(database, {
          userId,
          accessToken: 'second-access-token',
          refreshToken: 'second-refresh-token',
          key,
          previousSessionHash: row.id_hash,
        })

        await assert.rejects(
          createReadyAccountSession(database, {
            userId: missingUser,
            accessToken: 'failed-access-token',
            refreshToken: 'failed-refresh-token',
            key,
            previousSessionHash: sha256Hex(kept.sessionId),
          }),
          (error) => {
            assert.equal(error instanceof AccountSessionWriteError, true)
            assert.equal(error.code, 'rejected')
            assert.equal(String(error).includes('failed-access-token'), false)
            assert.equal(String(error).includes('failed-refresh-token'), false)
            return true
          },
        )
        assert.notEqual(
          await findAccountSession(database, sha256Hex(kept.sessionId)),
          null,
        )
      } finally {
        await database.query(
          'delete from public.account_sessions where user_id = $1',
          [userId],
        )
        await release()
      }
    },
  )

  it(
    'stores a challenge as hashes with a database expiry',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const challengeId = createLoginChallengeValue()
      const csrfSecret = createLoginChallengeValue()
      const idHash = sha256Hex(challengeId)

      try {
        const result = await createLoginChallenge(database, {
          challengeId,
          csrfSecret,
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        })
        const stored = await database.query(
          `
            select id_hash,
                   csrf_token_hash,
                   consumed_at,
                   extract(epoch from (expires_at - created_at)) as lifetime_seconds,
                   extract(epoch from (created_at - now())) as created_skew_seconds
            from public.login_challenges
            where id_hash = $1
          `,
          [idHash],
        )
        const row = stored.rows[0]
        const visible = JSON.stringify(row)

        assert.equal(result, undefined)
        assert.equal(row.id_hash, idHash)
        assert.equal(row.csrf_token_hash, sha256Hex(csrfSecret))
        assert.equal(row.consumed_at, null)
        assert.equal(Number(row.lifetime_seconds), 600)
        assert.ok(Math.abs(Number(row.created_skew_seconds)) < 30)
        assert.equal(visible.includes(challengeId), false)
        assert.equal(visible.includes(csrfSecret), false)
        assert.equal(
          await consumeLoginChallenge(database, {
            idHash,
            csrfTokenHash: sha256Hex(csrfSecret),
          }),
          1,
        )
        assert.equal(
          await consumeLoginChallenge(database, {
            idHash,
            csrfTokenHash: sha256Hex(csrfSecret),
          }),
          0,
        )

        await assert.rejects(
          createLoginChallenge(database, {
            challengeId,
            csrfSecret,
          }),
          (error) => {
            assert.equal(error instanceof AccountSessionWriteError, true)
            assert.equal(error.code, 'rejected')
            assert.equal(error.message, 'Account session write rejected')
            assert.equal(String(error).includes(challengeId), false)
            assert.equal(String(error).includes(csrfSecret), false)
            return true
          },
        )
      } finally {
        await database.query(
          'delete from public.login_challenges where id_hash = $1',
          [idHash],
        )
        await release()
      }
    },
  )

  it(
    'consumes one challenge and counts attempts once under concurrency',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)

      try {
        const challenge = {
          idHash: sha256Hex(randomUUID()),
          csrfTokenHash: sha256Hex(randomUUID()),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }
        await insertLoginChallenge(database, challenge)

        assert.equal(await consumeLoginChallenge(database, challenge), 1)
        assert.equal(await consumeLoginChallenge(database, challenge), 0)

        const attempt = {
          bucketHash: sha256Hex(randomUUID()),
          purpose: 'login',
          windowStart: new Date('2026-11-20T12:00:00.000Z'),
        }
        const counts = await Promise.all([
          incrementAuthAttempt(database, attempt),
          incrementAuthAttempt(database, attempt),
        ])

        assert.deepEqual(
          counts.sort((left, right) => left - right),
          [1, 2],
        )

        await database.query(
          'delete from public.login_challenges where id_hash = $1',
          [challenge.idHash],
        )
        await database.query(
          `
          delete from public.auth_attempt_counters
          where bucket_hash = $1 and purpose = $2 and window_start = $3
        `,
          [attempt.bucketHash, attempt.purpose, attempt.windowStart],
        )
      } finally {
        await release()
      }
    },
  )
})
