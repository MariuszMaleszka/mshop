import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerLoginChallengeRoutes } from '../src/account-session/routes.js'
import { authRateLimitBucket } from '../src/account-session/rate-limit.js'
import {
  isLoginChallengeValue,
  sha256Hex,
} from '../src/account-session/repository.js'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'
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
const hmacKey = randomBytes(32)
const bffSecret = randomBytes(32)
const clientIp = '203.0.113.44'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

describe('issued login challenges', () => {
  after(async () => {
    if (database) {
      await database.close()
    }
  })

  it(
    'stores only hashes after the real CSRF limit allows the call',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const lines = []
      const app = createApp(config, {
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
            bffTrustedPeers: ['127.0.0.1'],
            rateLimitHmacKey: hmacKey,
          })
        },
      })
      const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const bucket = authRateLimitBucket(hmacKey, ['csrf', clientIp])
      const forwardedBucket = authRateLimitBucket(hmacKey, [
        'csrf',
        '198.51.100.77',
      ])
      let challengeId
      let csrfSecret

      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/v1/internal/login-challenges`,
          {
            method: 'POST',
            headers: {
              'x-forwarded-for': '198.51.100.77',
              'x-mshop-client-ip': clientIp,
              'x-mshop-internal-secret': bffSecret.toString('base64'),
            },
          },
        )
        const body = await response.json()
        challengeId = body.challengeId
        csrfSecret = body.csrfSecret
        const stored = await database.query(
          `
            select id_hash, csrf_token_hash
            from public.login_challenges
            where id_hash = $1
          `,
          [sha256Hex(challengeId)],
        )
        const counter = await database.query(
          `
            select count
            from public.auth_attempt_counters
            where bucket_hash = $1 and purpose = 'csrf'
          `,
          [bucket],
        )
        const forwarded = await database.query(
          `
            select count(*)::int as count
            from public.auth_attempt_counters
            where bucket_hash = $1 and purpose = 'csrf'
          `,
          [forwardedBucket],
        )
        const visible = JSON.stringify(stored.rows[0])

        assert.equal(response.status, 200)
        assert.equal(isLoginChallengeValue(challengeId), true)
        assert.equal(isLoginChallengeValue(csrfSecret), true)
        assert.notEqual(challengeId, csrfSecret)
        assert.equal(stored.rows[0].id_hash, sha256Hex(challengeId))
        assert.equal(stored.rows[0].csrf_token_hash, sha256Hex(csrfSecret))
        assert.equal(visible.includes(challengeId), false)
        assert.equal(visible.includes(csrfSecret), false)
        assert.equal(Number(counter.rows[0].count), 1)
        assert.equal(forwarded.rows[0].count, 0)
        assert.equal(lines.join('\n').includes(challengeId), false)
        assert.equal(lines.join('\n').includes(csrfSecret), false)
        assert.equal(
          lines.join('\n').includes(bffSecret.toString('base64')),
          false,
        )
      } finally {
        if (challengeId) {
          await database.query(
            'delete from public.login_challenges where id_hash = $1',
            [sha256Hex(challengeId)],
          )
        }

        await database.query(
          `
            delete from public.auth_attempt_counters
            where bucket_hash = any($1::char(64)[])
          `,
          [[bucket, forwardedBucket]],
        )
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
        await release()
      }
    },
  )
})
