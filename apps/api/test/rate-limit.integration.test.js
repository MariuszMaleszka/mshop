import assert from 'node:assert/strict'
import { randomBytes, randomInt } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import {
  AUTH_RATE_LIMITS,
  authRateLimitBucket,
  consumeCsrfRateLimit,
  consumeLoginPairRateLimit,
  consumeLoginRateLimit,
  consumeRefreshRateLimit,
  deleteClosedAuthAttemptWindows,
} from '../src/account-session/rate-limit.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const key = randomBytes(32)
const buckets = []

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
      `select to_regclass('public.auth_attempt_counters') as counters`,
    )
    available = Boolean(tables.rows[0].counters)
  } catch {
    available = false
  } finally {
    await probe.end()
  }
}

const skip = available ? false : 'local auth attempt counters are not available'
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      logger: createLogger({ nodeEnv: 'test' }),
    })
  : null

function address() {
  return `203.0.113.${randomInt(1, 255)}`
}

function remember(purpose, ...fields) {
  const bucket = authRateLimitBucket(key, [purpose, ...fields])
  buckets.push(bucket)
  return bucket
}

async function stored(bucket, purpose) {
  const result = await database.query(
    `
      select bucket_hash, purpose, count, window_start
      from public.auth_attempt_counters
      where bucket_hash = $1 and purpose = $2
      order by window_start
    `,
    [bucket, purpose],
  )
  return result.rows
}

describe('auth rate limit storage', () => {
  after(async () => {
    if (!available || buckets.length === 0) {
      await database?.close()
      return
    }

    await database.query(
      'delete from public.auth_attempt_counters where bucket_hash = any($1::char(64)[])',
      [buckets],
    )
    await database.close()
  })

  it(
    'allows attempts through the limit and keeps the next one',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const ip = address()
      remember('login', ip)

      try {
        const first = await consumeLoginRateLimit(database, { key, ip })
        assert.equal(first.allowed, true)
        assert.equal(first.count, 1)
        assert.equal(first.limit, AUTH_RATE_LIMITS.login)
        assert.equal(first.windowStart.getTime() % (15 * 60 * 1000), 0)

        let last = first

        for (let count = 2; count <= AUTH_RATE_LIMITS.login; count += 1) {
          last = await consumeLoginRateLimit(database, { key, ip })
          assert.equal(last.allowed, true)
          assert.equal(last.count, count)
        }

        const rejected = await consumeLoginRateLimit(database, { key, ip })
        const again = await consumeLoginRateLimit(database, { key, ip })
        const rows = await stored(remember('login', ip), 'login')

        assert.equal(rejected.allowed, false)
        assert.equal(rejected.count, AUTH_RATE_LIMITS.login)
        assert.equal(again.allowed, false)
        assert.equal(again.count, AUTH_RATE_LIMITS.login)
        assert.equal(rows.length, 1)
        assert.equal(Number(rows[0].count), AUTH_RATE_LIMITS.login)
        assert.equal(last.windowStart.getTime(), rejected.windowStart.getTime())
      } finally {
        await release()
      }
    },
  )

  it('starts a new counter in the next window', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const ip = address()
    const bucket = remember('login', ip)

    try {
      await database.query(
        `
          insert into public.auth_attempt_counters (
            bucket_hash, purpose, window_start, count
          )
          values (
            $1,
            'login',
            date_bin(interval '15 minutes', now(), timestamptz 'epoch')
              - interval '15 minutes',
            $2
          )
        `,
        [bucket, AUTH_RATE_LIMITS.login],
      )

      const current = await consumeLoginRateLimit(database, { key, ip })
      const rows = await stored(bucket, 'login')

      assert.equal(current.allowed, true)
      assert.equal(current.count, 1)
      assert.equal(rows.length, 2)
      assert.equal(Number(rows[0].count), AUTH_RATE_LIMITS.login)
      assert.equal(Number(rows[1].count), 1)
    } finally {
      await release()
    }
  })

  it('does not let parallel attempts pass the limit', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const ip = address()
    const bucket = remember('login', ip)

    try {
      const results = await Promise.all(
        Array.from({ length: AUTH_RATE_LIMITS.login + 10 }, () =>
          consumeLoginRateLimit(database, { key, ip }),
        ),
      )
      const rows = await stored(bucket, 'login')
      const allowed = results.filter((result) => result.allowed)

      assert.equal(allowed.length, AUTH_RATE_LIMITS.login)
      assert.equal(Number(rows[0].count), AUTH_RATE_LIMITS.login)
      assert.equal(
        results.every((result) => result.count <= AUTH_RATE_LIMITS.login),
        true,
      )
    } finally {
      await release()
    }
  })

  it('keeps buckets and purposes independent', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const ip = address()
    const other = address()
    const email = `person+shop.${randomInt(1, 100000)}@example.com`
    const sessionId = `session-${randomInt(1, 100000)}`

    try {
      remember('login', ip)
      remember('login', other)
      remember('login_pair', ip, email.toLowerCase())
      remember('csrf', ip)
      remember('refresh', sessionId)

      const login = await consumeLoginRateLimit(database, { key, ip })
      const secondAddress = await consumeLoginRateLimit(database, {
        key,
        ip: other,
      })
      const pair = await consumeLoginPairRateLimit(database, {
        key,
        ip,
        email: ` ${email.toUpperCase()} `,
      })
      const csrf = await consumeCsrfRateLimit(database, { key, ip })
      const refresh = await consumeRefreshRateLimit(database, {
        key,
        sessionId,
      })

      assert.equal(login.count, 1)
      assert.equal(secondAddress.count, 1)
      assert.equal(pair.count, 1)
      assert.equal(pair.limit, AUTH_RATE_LIMITS.login_pair)
      assert.equal(csrf.count, 1)
      assert.equal(csrf.limit, AUTH_RATE_LIMITS.csrf)
      assert.equal(refresh.count, 1)
      assert.equal(refresh.purpose, 'refresh')

      const pairAgain = await consumeLoginPairRateLimit(database, {
        key,
        ip,
        email,
      })
      const loginAgain = await consumeLoginRateLimit(database, { key, ip })
      const pairRows = await stored(
        authRateLimitBucket(key, ['login_pair', ip, email.toLowerCase()]),
        'login_pair',
      )

      assert.equal(pairAgain.allowed, true)
      assert.equal(pairAgain.count, 2)
      assert.equal(Number(pairRows[0].count), 2)
      assert.equal(loginAgain.count, 2)
    } finally {
      await release()
    }
  })

  it('stores only the HMAC bucket', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const ip = address()
    const email = `hidden.person+tag.${randomInt(1, 100000)}@example.com`
    const sessionId = `hidden-session-${randomInt(1, 100000)}`
    const bucket = remember('login_pair', ip, email)

    try {
      await consumeLoginPairRateLimit(database, { key, ip, email })
      await consumeRefreshRateLimit(database, { key, sessionId })
      remember('refresh', sessionId)
      const rows = await database.query(
        `
          select bucket_hash, purpose, count::text
          from public.auth_attempt_counters
          where bucket_hash = any($1::char(64)[])
        `,
        [buckets],
      )
      const visible = JSON.stringify(rows.rows)

      assert.equal(visible.includes(ip), false)
      assert.equal(visible.includes(email), false)
      assert.equal(visible.includes(sessionId), false)
      assert.match(bucket, /^[0-9a-f]{64}$/)
    } finally {
      await release()
    }
  })

  it('deletes only closed windows', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const ip = address()
    const bucket = remember('csrf', ip)

    try {
      await consumeCsrfRateLimit(database, { key, ip })
      await database.query(
        `
          insert into public.auth_attempt_counters (
            bucket_hash, purpose, window_start, count
          )
          values (
            $1,
            'csrf',
            date_bin(interval '15 minutes', now(), timestamptz 'epoch')
              - interval '15 minutes',
            4
          )
        `,
        [bucket],
      )

      await deleteClosedAuthAttemptWindows(database)
      const rows = await stored(bucket, 'csrf')

      assert.equal(rows.length, 1)
      assert.equal(Number(rows[0].count), 1)
      assert.equal(rows[0].window_start.getTime() % (15 * 60 * 1000), 0)
    } finally {
      await release()
    }
  })

  it('keeps Supabase API roles off the session tables', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const tables = [
      'public.account_sessions',
      'public.login_challenges',
      'public.auth_attempt_counters',
    ]
    const blocked = ['anon', 'authenticated', 'service_role']

    try {
      const role = await database.query('select current_user as role')

      for (const table of tables) {
        const express = await database.query(
          'select has_table_privilege($1, $2, $3) as allowed',
          [role.rows[0].role, table, 'SELECT'],
        )
        assert.equal(express.rows[0].allowed, true)

        for (const grantee of blocked) {
          const denied = await database.query(
            'select has_table_privilege($1, $2, $3) as allowed',
            [grantee, table, 'SELECT'],
          )
          assert.equal(denied.rows[0].allowed, false)
        }
      }
    } finally {
      await release()
    }
  })
})
