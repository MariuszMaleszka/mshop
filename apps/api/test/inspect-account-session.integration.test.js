import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { inspectAccountSession } from '../src/account-session/inspect-account-session.js'
import {
  insertAccountSession,
  sha256Hex,
} from '../src/account-session/repository.js'
import { encryptToken } from '../src/account-session/token-cipher.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const accessToken = 'inspect-access-token'
const refreshToken = 'inspect-refresh-token'

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

function seal(value) {
  return encryptToken(value, key)
}

function sessionRow(userId, overrides = {}) {
  const access = seal(accessToken)
  const refresh = seal(refreshToken)

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
    absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    ...overrides,
  }
}

async function insertUser() {
  const userId = randomUUID()
  await database.query('insert into auth.users (id) values ($1)', [userId])
  userIds.push(userId)
  return userId
}

async function snapshot(idHash) {
  const result = await database.query(
    `
      select refresh_state, absolute_expires_at, idle_expires_at, updated_at
      from public.account_sessions
      where id_hash = $1
    `,
    [idHash],
  )
  return result.rows[0]
}

describe('inspect account session storage', () => {
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
    'classifies stored sessions from PostgreSQL time without writing',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = await insertUser()

      try {
        const ready = sessionRow(userId)
        const idle = sessionRow(userId)
        const absolute = sessionRow(userId)
        const young = sessionRow(userId, {
          refreshState: 'pending',
          refreshGeneration: randomUUID(),
          refreshStartedAt: new Date(),
          refreshTokenHash: sha256Hex('refresh-token'),
          accessTag: randomBytes(16),
        })
        const future = sessionRow(userId, {
          refreshState: 'pending',
          refreshGeneration: randomUUID(),
          refreshStartedAt: new Date(),
          refreshTokenHash: sha256Hex('future-refresh-token'),
          accessTag: randomBytes(16),
        })
        const stale = sessionRow(userId, {
          refreshState: 'pending',
          refreshGeneration: randomUUID(),
          refreshStartedAt: new Date(Date.now() - 60_000),
          refreshTokenHash: sha256Hex('old-refresh-token'),
          accessTag: randomBytes(16),
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
        const broken = sessionRow(userId, { accessTag: randomBytes(16) })

        for (const session of [
          ready,
          idle,
          absolute,
          young,
          future,
          stale,
          unknown,
          broken,
        ]) {
          await insertAccountSession(database, session)
        }

        await database.query(
          `
            update public.account_sessions
            set created_at = now() - interval '2 hours',
                idle_expires_at = now() - interval '1 minute',
                absolute_expires_at = now() + interval '1 hour'
            where id_hash = $1
          `,
          [idle.idHash],
        )
        await database.query(
          `
            update public.account_sessions
            set created_at = now() - interval '13 hours',
                idle_expires_at = now() - interval '2 hours',
                absolute_expires_at = now() - interval '1 minute'
            where id_hash = $1
          `,
          [absolute.idHash],
        )
        await database.query(
          `
            update public.account_sessions
            set refresh_started_at = now()
            where id_hash = $1
          `,
          [young.idHash],
        )
        await database.query(
          `
            update public.account_sessions
            set refresh_started_at = now() + interval '1 minute'
            where id_hash = $1
          `,
          [future.idHash],
        )
        await database.query(
          `
            update public.account_sessions
            set refresh_started_at = now() - interval '16 seconds'
            where id_hash = $1
          `,
          [stale.idHash],
        )

        const before = await snapshot(ready.idHash)
        const missing = await inspectAccountSession({
          database,
          sessionHash: sha256Hex(randomUUID()),
          key,
        })
        const readyResult = await inspectAccountSession({
          database,
          sessionHash: ready.idHash,
          key,
        })
        const idleResult = await inspectAccountSession({
          database,
          sessionHash: idle.idHash,
          key,
        })
        const absoluteResult = await inspectAccountSession({
          database,
          sessionHash: absolute.idHash,
          key,
        })
        const youngResult = await inspectAccountSession({
          database,
          sessionHash: young.idHash,
          key,
        })
        const futureResult = await inspectAccountSession({
          database,
          sessionHash: future.idHash,
          key,
        })
        const staleResult = await inspectAccountSession({
          database,
          sessionHash: stale.idHash,
          key,
        })
        const unknownResult = await inspectAccountSession({
          database,
          sessionHash: unknown.idHash,
          key,
        })
        const brokenResult = await inspectAccountSession({
          database,
          sessionHash: broken.idHash,
          key,
        })
        const wrongKey = await inspectAccountSession({
          database,
          sessionHash: ready.idHash,
          key: randomBytes(32),
        })
        const after = await snapshot(ready.idHash)

        assert.deepEqual(missing, { status: 'not_found' })
        assert.deepEqual(readyResult, {
          status: 'ready',
          userId,
          accessToken,
          refreshToken,
          keyVersion: 1,
        })
        assert.deepEqual(idleResult, { status: 'expired' })
        assert.deepEqual(absoluteResult, { status: 'expired' })
        assert.deepEqual(youngResult, { status: 'pending' })
        assert.deepEqual(futureResult, { status: 'invalid' })
        assert.deepEqual(staleResult, { status: 'stale_pending' })
        assert.deepEqual(unknownResult, { status: 'unknown' })
        assert.deepEqual(brokenResult, { status: 'invalid' })
        assert.deepEqual(wrongKey, { status: 'invalid' })
        assert.equal(before.updated_at.getTime(), after.updated_at.getTime())
        assert.equal(
          before.idle_expires_at.getTime(),
          after.idle_expires_at.getTime(),
        )
        assert.equal(
          before.absolute_expires_at.getTime(),
          after.absolute_expires_at.getTime(),
        )

        for (const result of [
          missing,
          idleResult,
          absoluteResult,
          youngResult,
          futureResult,
          staleResult,
          unknownResult,
          brokenResult,
          wrongKey,
        ]) {
          const visible = JSON.stringify(result)
          assert.equal(visible.includes(accessToken), false)
          assert.equal(visible.includes(refreshToken), false)
          assert.equal(visible.includes(ready.idHash), false)
        }
      } finally {
        await release()
      }
    },
  )
})
