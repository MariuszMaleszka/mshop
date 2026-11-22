import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerLoginChallengeRoutes } from '../src/account-session/routes.js'
import {
  authRateLimitBucket,
  consumeCsrfRateLimit,
} from '../src/account-session/rate-limit.js'
import { sha256Hex } from '../src/account-session/repository.js'
import { createApp } from '../src/app.js'
import { createDatabase } from '../src/db/pool.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'
import { bootstrapCsrfChallenge } from '../../web/server/utils/csrf-bootstrap.js'
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
const database = available
  ? createDatabase({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      logger: createLogger({ nodeEnv: 'test' }),
    })
  : null
const hmacKey = randomBytes(32)
const bffSecret = randomBytes(32)
const allowedOrigin = 'http://localhost:3000'
const clientIp = '203.0.113.70'
const limitedIp = '203.0.113.71'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: allowedOrigin,
})

async function challengeCount() {
  const result = await database.query(
    'select count(*)::int as count from public.login_challenges',
  )
  return result.rows[0].count
}

describe('Nuxt CSRF bootstrap', () => {
  after(async () => {
    if (database) {
      await database.close()
    }
  })

  it(
    'stores a hashed challenge only after a valid browser source',
    { skip },
    async () => {
      const release = await holdIntegrationDatabase(databaseUrl)
      const app = createApp(config, {
        logger: createLogger({ nodeEnv: 'test' }),
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
      const apiBase = `http://127.0.0.1:${port}/api/v1`
      const browser = {
        socket: { remoteAddress: clientIp },
        headers: {
          'x-forwarded-for': '198.51.100.8',
          'x-mshop-client-ip': '192.0.2.9',
        },
      }
      const buckets = [
        authRateLimitBucket(hmacKey, ['csrf', clientIp]),
        authRateLimitBucket(hmacKey, ['csrf', '198.51.100.8']),
        authRateLimitBucket(hmacKey, ['csrf', '192.0.2.9']),
        authRateLimitBucket(hmacKey, ['csrf', limitedIp]),
      ]
      let idHash

      try {
        const before = await challengeCount()
        const denied = await bootstrapCsrfChallenge({
          origin: 'https://evil.example',
          referer: `${allowedOrigin}/login`,
          request: browser,
          allowedOrigin,
          secret: bffSecret.toString('base64'),
          apiBase,
          nodeEnv: 'test',
        })

        assert.equal(denied.status, 403)
        assert.equal(denied.cookie, null)
        assert.equal(await challengeCount(), before)

        const issued = await bootstrapCsrfChallenge({
          origin: allowedOrigin,
          request: browser,
          allowedOrigin,
          secret: bffSecret.toString('base64'),
          apiBase,
          nodeEnv: 'test',
        })
        idHash = sha256Hex(issued.cookie.value)
        const stored = await database.query(
          `
            select id_hash, csrf_token_hash
            from public.login_challenges
            where id_hash = $1
          `,
          [idHash],
        )
        const counted = await database.query(
          `
            select bucket_hash, count
            from public.auth_attempt_counters
            where purpose = 'csrf' and bucket_hash = any($1::char(64)[])
          `,
          [buckets.slice(0, 3)],
        )
        const visible = JSON.stringify(stored.rows[0])

        assert.equal(issued.status, 200)
        assert.deepEqual(issued.body, { csrfSecret: issued.body.csrfSecret })
        assert.equal(Object.keys(issued.body).join(), 'csrfSecret')
        assert.equal(issued.cookie.name, 'mshop_login')
        assert.equal(issued.cookie.value === issued.body.csrfSecret, false)
        assert.equal(stored.rows[0].id_hash, idHash)
        assert.equal(
          stored.rows[0].csrf_token_hash,
          sha256Hex(issued.body.csrfSecret),
        )
        assert.equal(visible.includes(issued.cookie.value), false)
        assert.equal(visible.includes(issued.body.csrfSecret), false)
        assert.equal(counted.rows.length, 1)
        assert.equal(counted.rows[0].bucket_hash, buckets[0])
        assert.equal(Number(counted.rows[0].count), 1)

        const failed = await bootstrapCsrfChallenge({
          origin: allowedOrigin,
          request: browser,
          allowedOrigin,
          secret: randomBytes(32).toString('base64'),
          apiBase,
          nodeEnv: 'test',
        })

        assert.equal(failed.status, 503)
        assert.equal(failed.cookie, null)
        assert.equal(JSON.stringify(failed.body).includes('csrfSecret'), false)
        assert.equal(await challengeCount(), before + 1)

        for (let attempt = 0; attempt < 60; attempt += 1) {
          await consumeCsrfRateLimit(database, { key: hmacKey, ip: limitedIp })
        }

        const limited = await bootstrapCsrfChallenge({
          origin: allowedOrigin,
          request: { socket: { remoteAddress: limitedIp } },
          allowedOrigin,
          secret: bffSecret.toString('base64'),
          apiBase,
          nodeEnv: 'test',
        })

        assert.equal(limited.status, 429)
        assert.deepEqual(limited.body, { code: 'rate_limited' })
        assert.equal(limited.cookie, null)
        assert.equal(await challengeCount(), before + 1)
      } finally {
        if (idHash) {
          await database.query(
            'delete from public.login_challenges where id_hash = $1',
            [idHash],
          )
        }

        await database.query(
          `
            delete from public.auth_attempt_counters
            where purpose = 'csrf' and bucket_hash = any($1::char(64)[])
          `,
          [buckets],
        )
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
        await release()
      }
    },
  )
})
