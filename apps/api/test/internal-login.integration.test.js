import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerLoginChallengeRoutes } from '../src/account-session/routes.js'
import { authRateLimitBucket } from '../src/account-session/rate-limit.js'
import {
  createLoginChallenge,
  createLoginChallengeValue,
  sha256Hex,
} from '../src/account-session/repository.js'
import { decryptToken } from '../src/account-session/token-cipher.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { holdIntegrationDatabase } from './integration-lock.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const accessToken = 'integration-access-token'
const refreshToken = 'integration-refresh-token'
const userIds = []
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

const skip = available ? false : 'local login tables are not available'
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      logger: createLogger({ nodeEnv: 'test' }),
    })
  : null

describe('internal login storage', () => {
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

  it(
    'stores the session from the authenticated internal call without returning tokens',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const userId = randomUUID()
      const clientIp = '203.0.113.70'
      const email = 'internal-login@example.com'
      const password = 'integration-password'
      const challengeId = createLoginChallengeValue()
      const csrfSecret = createLoginChallengeValue()
      const hmacKey = randomBytes(32)
      const sessionKey = randomBytes(32)
      const bffSecret = randomBytes(32)
      const lines = []
      userIds.push(userId)
      challengeHashes.push(sha256Hex(challengeId))
      buckets.push(
        authRateLimitBucket(hmacKey, ['login', clientIp]),
        authRateLimitBucket(hmacKey, ['login_pair', clientIp, email]),
      )
      await database.query('insert into auth.users (id) values ($1)', [userId])
      await createLoginChallenge(database, { challengeId, csrfSecret })
      const app = createApp(
        loadConfig({
          NODE_ENV: 'test',
          WEB_ORIGIN: 'http://localhost:3000',
        }),
        {
          logger: createLogger({
            nodeEnv: 'development',
            write(_level, line) {
              lines.push(line)
            },
          }),
          registerRoutes(router) {
            registerLoginChallengeRoutes(router, {
              database,
              bffInternalSecret: bffSecret,
              bffTrustedPeers: ['127.0.0.1', '::1'],
              rateLimitHmacKey: hmacKey,
              sessionTokenKey: sessionKey,
              supabaseUrl: 'http://127.0.0.1:54321',
              supabaseAnonKey: 'anon-key-value',
              loginDependencies: {
                async signIn() {
                  return {
                    accessToken,
                    refreshToken,
                    expiresAt: 1_800_000_000,
                    userId,
                  }
                },
              },
            })
          },
        },
      )
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0

      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/v1/internal/login`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': '198.51.100.8',
              'x-mshop-client-ip': clientIp,
              'x-mshop-internal-secret': bffSecret.toString('base64'),
            },
            body: JSON.stringify({
              challengeId,
              csrfSecret,
              email,
              password,
              clientIp: '192.0.2.9',
            }),
          },
        )
        const payload = await response.json()
        const logged = lines.join('\n')

        assert.equal(response.status, 400)
        assert.deepEqual(payload, { code: 'invalid_request' })

        const accepted = await fetch(
          `http://127.0.0.1:${port}/api/v1/internal/login`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': '198.51.100.8',
              'x-mshop-client-ip': clientIp,
              'x-mshop-internal-secret': bffSecret.toString('base64'),
            },
            body: JSON.stringify({ challengeId, csrfSecret, email, password }),
          },
        )
        const created = await accepted.json()
        const row = (
          await database.query(
            `
              select user_id, refresh_state, access_ciphertext, access_nonce,
                     access_tag, key_version
              from public.account_sessions
              where id_hash = $1
            `,
            [sha256Hex(created.sessionId)],
          )
        ).rows[0]
        const challenge = await database.query(
          'select consumed_at from public.login_challenges where id_hash = $1',
          [sha256Hex(challengeId)],
        )

        assert.equal(accepted.status, 200)
        assert.deepEqual(Object.keys(created).sort(), [
          'csrfSecret',
          'sessionId',
        ])
        assert.equal(JSON.stringify(created).includes(accessToken), false)
        assert.equal(JSON.stringify(created).includes(refreshToken), false)
        assert.equal(JSON.stringify(created).includes(password), false)
        assert.equal(row.user_id, userId)
        assert.equal(row.refresh_state, 'ready')
        assert.equal(
          decryptToken(
            {
              ciphertext: row.access_ciphertext,
              nonce: row.access_nonce,
              tag: row.access_tag,
              version: row.key_version,
            },
            sessionKey,
          ),
          accessToken,
        )
        assert.equal(challenge.rows[0].consumed_at instanceof Date, true)
        assert.equal(logged.includes(password), false)
        assert.equal(logged.includes(accessToken), false)
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
        await release()
      }
    },
  )
})
