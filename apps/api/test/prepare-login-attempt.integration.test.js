import assert from 'node:assert/strict'
import { randomBytes, randomInt } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import {
  LoginAttemptError,
  prepareLoginAttempt,
} from '../src/account-session/prepare-login-attempt.js'
import { authRateLimitBucket } from '../src/account-session/rate-limit.js'
import {
  createLoginChallenge,
  createLoginChallengeValue,
  sha256Hex,
} from '../src/account-session/repository.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const key = randomBytes(32)
const challengeHashes = []
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
      `
        select to_regclass('public.login_challenges') as challenges,
               to_regclass('public.auth_attempt_counters') as counters
      `,
    )
    available = Boolean(tables.rows[0].challenges && tables.rows[0].counters)
  } catch {
    available = false
  } finally {
    await probe.end()
  }
}

const skip = available ? false : 'local login attempt tables are not available'
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
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

async function issueChallenge() {
  const challengeId = createLoginChallengeValue()
  const csrfSecret = createLoginChallengeValue()
  await createLoginChallenge(database, { challengeId, csrfSecret })
  challengeHashes.push(sha256Hex(challengeId))
  return { challengeId, csrfSecret }
}

async function counter(bucket, purpose) {
  const result = await database.query(
    `
      select count
      from public.auth_attempt_counters
      where bucket_hash = $1 and purpose = $2
    `,
    [bucket, purpose],
  )
  return result.rows[0] ? Number(result.rows[0].count) : 0
}

async function consumedAt(challengeId) {
  const result = await database.query(
    `
      select consumed_at
      from public.login_challenges
      where id_hash = $1
    `,
    [sha256Hex(challengeId)],
  )
  return result.rows[0]?.consumed_at ?? null
}

describe('prepare login attempt storage', () => {
  after(async () => {
    if (!available) {
      return
    }

    if (challengeHashes.length > 0) {
      await database.query(
        'delete from public.login_challenges where id_hash = any($1::char(64)[])',
        [challengeHashes],
      )
    }

    if (buckets.length > 0) {
      await database.query(
        'delete from public.auth_attempt_counters where bucket_hash = any($1::char(64)[])',
        [buckets],
      )
    }

    await database.close()
  })

  it('consumes one challenge and both login limits', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const clientIp = address()
    const email = `person-${randomInt(1000, 9999)}@example.com`
    const loginBucket = remember('login', clientIp)
    const pairBucket = remember('login_pair', clientIp, email)
    const { challengeId, csrfSecret } = await issueChallenge()

    try {
      const prepared = await prepareLoginAttempt({
        database,
        clientIp,
        challengeId,
        csrfSecret,
        email,
        key,
      })
      const repeated = await prepareLoginAttempt({
        database,
        clientIp,
        challengeId,
        csrfSecret,
        email,
        key,
      }).catch((error) => error)

      assert.deepEqual(prepared, { ok: true })
      assert.equal(repeated instanceof LoginAttemptError, true)
      assert.equal(repeated.code, 'invalid_challenge')
      assert.equal((await consumedAt(challengeId)) instanceof Date, true)
      assert.equal(await counter(loginBucket, 'login'), 1)
      assert.equal(await counter(pairBucket, 'login_pair'), 1)
    } finally {
      await release()
    }
  })

  it(
    'does not consume a challenge with the wrong secret',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const clientIp = address()
      const email = `wrong-${randomInt(1000, 9999)}@example.com`
      const loginBucket = remember('login', clientIp)
      const { challengeId } = await issueChallenge()
      const csrfSecret = createLoginChallengeValue()

      try {
        const error = await prepareLoginAttempt({
          database,
          clientIp,
          challengeId,
          csrfSecret,
          email,
          key,
        }).catch((caught) => caught)

        assert.equal(error instanceof LoginAttemptError, true)
        assert.equal(error.code, 'invalid_challenge')
        assert.equal(await consumedAt(challengeId), null)
        assert.equal(await counter(loginBucket, 'login'), 0)
      } finally {
        await release()
      }
    },
  )

  it('does not consume an expired challenge', { skip }, async () => {
    const release = await holdIntegrationDatabase(databaseUrl)
    const clientIp = address()
    const email = `expired-${randomInt(1000, 9999)}@example.com`
    const challengeId = createLoginChallengeValue()
    const csrfSecret = createLoginChallengeValue()
    const idHash = sha256Hex(challengeId)
    challengeHashes.push(idHash)

    try {
      await database.query(
        `
          insert into public.login_challenges (
            id_hash, csrf_token_hash, created_at, expires_at
          )
          values (
            $1, $2, now() - interval '2 minutes', now() - interval '1 minute'
          )
        `,
        [idHash, sha256Hex(csrfSecret)],
      )
      const error = await prepareLoginAttempt({
        database,
        clientIp,
        challengeId,
        csrfSecret,
        email,
        key,
      }).catch((caught) => caught)

      assert.equal(error instanceof LoginAttemptError, true)
      assert.equal(error.code, 'invalid_challenge')
      assert.equal(await consumedAt(challengeId), null)
    } finally {
      await release()
    }
  })

  it(
    'stops after the address limit and leaves the pair limit untouched',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const clientIp = address()
      const email = `limited-${randomInt(1000, 9999)}@example.com`
      const loginBucket = remember('login', clientIp)
      const pairBucket = remember('login_pair', clientIp, email)
      const { challengeId, csrfSecret } = await issueChallenge()

      try {
        await database.query(
          `
          insert into public.auth_attempt_counters (
            bucket_hash, purpose, window_start, count
          )
          values (
            $1, 'login',
            date_bin(interval '15 minutes', now(), timestamptz 'epoch'),
            30
          )
        `,
          [loginBucket],
        )
        const error = await prepareLoginAttempt({
          database,
          clientIp,
          challengeId,
          csrfSecret,
          email,
          key,
        }).catch((caught) => caught)

        assert.equal(error instanceof LoginAttemptError, true)
        assert.equal(error.code, 'rate_limited')
        assert.equal((await consumedAt(challengeId)) instanceof Date, true)
        assert.equal(await counter(loginBucket, 'login'), 30)
        assert.equal(await counter(pairBucket, 'login_pair'), 0)
      } finally {
        await release()
      }
    },
  )

  it(
    'rejects the address and email pair after the address limit allows it',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const clientIp = address()
      const email = `pair-${randomInt(1000, 9999)}@example.com`
      const loginBucket = remember('login', clientIp)
      const pairBucket = remember('login_pair', clientIp, email)
      const { challengeId, csrfSecret } = await issueChallenge()

      try {
        await database.query(
          `
          insert into public.auth_attempt_counters (
            bucket_hash, purpose, window_start, count
          )
          values (
            $1, 'login_pair',
            date_bin(interval '15 minutes', now(), timestamptz 'epoch'),
            10
          )
        `,
          [pairBucket],
        )
        const error = await prepareLoginAttempt({
          database,
          clientIp,
          challengeId,
          csrfSecret,
          email,
          key,
        }).catch((caught) => caught)

        assert.equal(error instanceof LoginAttemptError, true)
        assert.equal(error.code, 'rate_limited')
        assert.equal((await consumedAt(challengeId)) instanceof Date, true)
        assert.equal(await counter(loginBucket, 'login'), 1)
        assert.equal(await counter(pairBucket, 'login_pair'), 10)
      } finally {
        await release()
      }
    },
  )

  it(
    'leaves a consumed challenge when the limiter fails afterwards',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const clientIp = address()
      const email = `failure-${randomInt(1000, 9999)}@example.com`
      const { challengeId, csrfSecret } = await issueChallenge()
      const failingDatabase = {
        async query(text, params) {
          if (text.includes('auth_attempt_counters')) {
            throw new Error(`limiter failed ${email} ${challengeId}`)
          }

          return database.query(text, params)
        },
      }

      try {
        const error = await prepareLoginAttempt({
          database: failingDatabase,
          clientIp,
          challengeId,
          csrfSecret,
          email,
          key,
        }).catch((caught) => caught)

        assert.equal(error instanceof LoginAttemptError, true)
        assert.equal(error.code, 'unavailable')
        assert.equal(String(error).includes(email), false)
        assert.equal(String(error).includes(challengeId), false)
        assert.equal((await consumedAt(challengeId)) instanceof Date, true)
      } finally {
        await release()
      }
    },
  )

  it(
    'does not consume a challenge when the HMAC key is missing',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const { challengeId, csrfSecret } = await issueChallenge()

      try {
        const error = await prepareLoginAttempt({
          database,
          clientIp: address(),
          challengeId,
          csrfSecret,
          email: 'missing-key@example.com',
          key: null,
        }).catch((caught) => caught)

        assert.equal(error instanceof LoginAttemptError, true)
        assert.equal(error.code, 'unavailable')
        assert.equal(await consumedAt(challengeId), null)
      } finally {
        await release()
      }
    },
  )

  it(
    'lets only one of two parallel attempts reach the limits',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const clientIp = address()
      const email = `race-${randomInt(1000, 9999)}@example.com`
      const loginBucket = remember('login', clientIp)
      const pairBucket = remember('login_pair', clientIp, email)
      const { challengeId, csrfSecret } = await issueChallenge()

      try {
        const results = await Promise.all([
          prepareLoginAttempt({
            database,
            clientIp,
            challengeId,
            csrfSecret,
            email,
            key,
          }).catch((error) => error),
          prepareLoginAttempt({
            database,
            clientIp,
            challengeId,
            csrfSecret,
            email,
            key,
          }).catch((error) => error),
        ])
        const prepared = results.filter((result) => result?.ok === true)
        const rejected = results.filter(
          (result) => result instanceof LoginAttemptError,
        )

        assert.equal(prepared.length, 1)
        assert.equal(rejected.length, 1)
        assert.equal(rejected[0].code, 'invalid_challenge')
        assert.equal(await counter(loginBucket, 'login'), 1)
        assert.equal(await counter(pairBucket, 'login_pair'), 1)
      } finally {
        await release()
      }
    },
  )
})
