import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  AuthRateLimitError,
  authRateLimitBucket,
  consumeLoginRateLimit,
  normalizeLoginEmail,
} from '../src/account-session/rate-limit.js'

const key = randomBytes(32)

describe('auth rate limit buckets', () => {
  it('keeps a bucket stable and separates subjects', () => {
    const ip = authRateLimitBucket(key, ['login', '203.0.113.10'])

    assert.equal(authRateLimitBucket(key, ['login', '203.0.113.10']), ip)
    assert.notEqual(authRateLimitBucket(key, ['login', '203.0.113.11']), ip)
    assert.notEqual(
      authRateLimitBucket(key, ['login_pair', '203.0.113.10', 'a@example.com']),
      authRateLimitBucket(key, ['login_pair', '203.0.113.10', 'b@example.com']),
    )
    assert.notEqual(
      authRateLimitBucket(key, ['refresh', 'session-a']),
      authRateLimitBucket(key, ['refresh', 'session-b']),
    )
    assert.notEqual(
      authRateLimitBucket(key, ['login_pair', 'ab', 'c']),
      authRateLimitBucket(key, ['login_pair', 'a', 'bc']),
    )
    assert.notEqual(
      authRateLimitBucket(key, ['login', '203.0.113.10']),
      authRateLimitBucket(key, ['csrf', '203.0.113.10']),
    )
  })

  it('uses one bucket for an IPv4 address and its mapped IPv6 form', async () => {
    const seen = []
    const database = {
      async query(_sql, params) {
        seen.push(params[0])
        return { rows: [{ count: 1, window_start: new Date(0) }] }
      },
    }

    await consumeLoginRateLimit(database, { key, ip: '203.0.113.10' })
    await consumeLoginRateLimit(database, { key, ip: '::ffff:203.0.113.10' })

    assert.equal(seen[0], seen[1])
    assert.match(seen[0], /^[0-9a-f]{64}$/)
  })

  it('normalizes email without removing dots or plus aliases', () => {
    assert.equal(
      normalizeLoginEmail(' User.Name+Shop@Example.COM '),
      'user.name+shop@example.com',
    )
    assert.notEqual(
      normalizeLoginEmail('user.name@example.com'),
      normalizeLoginEmail('username@example.com'),
    )
  })

  it('fails closed without a key and does not reveal it', async () => {
    const secret = key.toString('base64')
    const database = {
      async query() {
        throw new Error('query should not run')
      },
    }

    await assert.rejects(
      consumeLoginRateLimit(database, { key: null, ip: '203.0.113.10' }),
      (error) => {
        assert.equal(error instanceof AuthRateLimitError, true)
        assert.equal(error.code, 'missing_key')
        assert.equal(error.message, 'Auth rate limit failed')
        assert.equal(String(error).includes(secret), false)
        assert.equal(String(error).includes('203.0.113.10'), false)
        return true
      },
    )

    await assert.rejects(
      consumeLoginRateLimit(database, {
        key: Buffer.alloc(16),
        ip: '203.0.113.10',
      }),
      (error) =>
        error instanceof AuthRateLimitError && error.code === 'invalid_key',
    )
  })

  it('does not treat a database failure as an allow', async () => {
    const database = {
      async query() {
        throw Object.assign(new Error('password=hidden-db-secret'), {
          code: '57P01',
        })
      },
    }

    await assert.rejects(
      consumeLoginRateLimit(database, { key, ip: '203.0.113.10' }),
      (error) => {
        assert.equal(error instanceof AuthRateLimitError, true)
        assert.equal(error.code, 'unavailable')
        assert.equal(error.message, 'Auth rate limit failed')
        assert.equal(String(error).includes('hidden-db-secret'), false)
        assert.equal('allowed' in error, false)
        return true
      },
    )
  })
})
