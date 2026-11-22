import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'

const productionBase = {
  NODE_ENV: 'production',
  PORT: '8080',
  WEB_ORIGIN: 'https://shop.example',
  DATABASE_URL: 'postgresql://app:long-lived-db-password@db.internal:5432/shop',
  SUPABASE_URL: 'https://project.supabase.co',
}

function configError(env) {
  try {
    loadConfig(env)
  } catch (error) {
    return error
  }

  assert.fail('expected configuration to fail')
}

describe('loadConfig', () => {
  it('accepts a development configuration with local defaults', () => {
    const config = loadConfig({ NODE_ENV: 'development' })

    assert.deepEqual(config, {
      nodeEnv: 'development',
      port: 3001,
      webOrigin: 'http://localhost:3000',
      databaseUrl: null,
      databasePoolMax: 10,
      databaseConnectionTimeoutMs: 5000,
      databaseIdleTimeoutMs: 10000,
      supabaseUrl: null,
      supabaseAnonKey: null,
      supabaseServiceRoleKey: null,
      sessionTokenKey: null,
      rateLimitHmacKey: null,
      bffInternalSecret: null,
      bffTrustedPeers: [],
      p24: null,
    })
  })

  it('accepts a test configuration without secrets', () => {
    const config = loadConfig({ NODE_ENV: 'test' })

    assert.equal(config.nodeEnv, 'test')
    assert.equal(config.databaseUrl, null)
    assert.equal(config.supabaseUrl, null)
  })

  it('accepts a local database in development', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      SUPABASE_URL: 'http://127.0.0.1:54321',
    })

    assert.equal(
      config.databaseUrl,
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    )
    assert.equal(config.supabaseUrl, 'http://127.0.0.1:54321')
  })

  it('rejects a remote database in test', () => {
    const secret = 'remote-db-password'
    const error = configError({
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://app:${secret}@db.example:5432/shop`,
    })

    assert.match(error.message, /DATABASE_URL/)
    assert.equal(error.message.includes(secret), false)
  })

  it('rejects production without required addresses', () => {
    const error = configError({ NODE_ENV: 'production' })

    assert.match(error.message, /WEB_ORIGIN/)
    assert.match(error.message, /DATABASE_URL/)
    assert.match(error.message, /SUPABASE_URL/)
    assert.equal(error.message.includes('localhost'), false)
  })

  it('rejects an unknown NODE_ENV', () => {
    const error = configError({ NODE_ENV: 'staging' })

    assert.match(error.message, /NODE_ENV/)
  })

  it('rejects an invalid PORT', () => {
    const error = configError({ NODE_ENV: 'development', PORT: '3001abc' })

    assert.match(error.message, /PORT/)
    assert.equal(error.message.includes('3001abc'), false)
  })

  it('rejects an origin that is not a bare URL', () => {
    const error = configError({
      NODE_ENV: 'development',
      WEB_ORIGIN: 'http://localhost:3000/shop',
    })

    assert.match(error.message, /WEB_ORIGIN/)
    assert.equal(error.message.includes('/shop'), false)
  })

  it('rejects production HTTP and local origins', () => {
    const httpError = configError({
      ...productionBase,
      WEB_ORIGIN: 'http://shop.example',
    })
    const localError = configError({
      ...productionBase,
      WEB_ORIGIN: 'https://localhost',
    })

    assert.match(httpError.message, /HTTPS/)
    assert.match(localError.message, /local host/)
    assert.equal(localError.message.includes('https://localhost'), false)
  })

  it('rejects a local database URL in production', () => {
    const secret = 'super-secret-db-password'
    const error = configError({
      ...productionBase,
      DATABASE_URL: `postgresql://app:${secret}@127.0.0.1:5432/shop`,
    })

    assert.match(error.message, /DATABASE_URL/)
    assert.equal(error.message.includes(secret), false)
  })

  it('rejects a development database credential in production', () => {
    const error = configError({
      ...productionBase,
      DATABASE_URL: 'postgresql://postgres:postgres@db.internal:5432/shop',
    })

    assert.match(error.message, /DATABASE_URL/)
    assert.equal(error.message.includes('postgres:postgres'), false)
  })

  it('does not reveal an invalid service key', () => {
    const secret = 'service-role-secret-value'
    const error = configError({
      NODE_ENV: 'development',
      SUPABASE_SERVICE_ROLE_KEY: `${secret} with spaces`,
    })

    assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY/)
    assert.equal(error.message.includes(secret), false)
  })

  it('accepts a 32-byte session token key and rejects a short one', () => {
    const key = randomBytes(32)
    const config = loadConfig({
      NODE_ENV: 'test',
      SESSION_TOKEN_KEY: key.toString('base64'),
    })

    assert.equal(config.sessionTokenKey.equals(key), true)

    const error = configError({
      NODE_ENV: 'test',
      SESSION_TOKEN_KEY: 'not-a-key',
    })

    assert.match(error.message, /SESSION_TOKEN_KEY/)
    assert.equal(error.message.includes('not-a-key'), false)
  })

  it('accepts a 32-byte rate limit key and rejects a short one', () => {
    const key = randomBytes(32)
    const config = loadConfig({
      NODE_ENV: 'test',
      RATE_LIMIT_HMAC_KEY: key.toString('base64'),
    })

    assert.equal(config.rateLimitHmacKey.equals(key), true)

    const error = configError({
      NODE_ENV: 'test',
      RATE_LIMIT_HMAC_KEY: 'not-a-key',
    })

    assert.match(error.message, /RATE_LIMIT_HMAC_KEY/)
    assert.equal(error.message.includes('not-a-key'), false)
  })

  it('rejects an all-zero rate limit key in production', () => {
    const error = configError({
      ...productionBase,
      RATE_LIMIT_HMAC_KEY: Buffer.alloc(32).toString('base64'),
    })

    assert.match(error.message, /RATE_LIMIT_HMAC_KEY/)
    assert.equal(error.message.includes('AAAA'), false)
  })

  it('rejects an all-zero session token key in production', () => {
    const error = configError({
      ...productionBase,
      SESSION_TOKEN_KEY: Buffer.alloc(32).toString('base64'),
    })

    assert.match(error.message, /SESSION_TOKEN_KEY/)
  })

  it('accepts canonical trusted peers and a 32-byte internal secret', () => {
    const key = randomBytes(32)
    const config = loadConfig({
      NODE_ENV: 'test',
      BFF_INTERNAL_SECRET: key.toString('base64'),
      BFF_TRUSTED_PEERS: '127.0.0.1, ::ffff:10.0.0.1, ::1',
    })

    assert.equal(config.bffInternalSecret.equals(key), true)
    assert.deepEqual(config.bffTrustedPeers, ['127.0.0.1', '10.0.0.1', '::1'])
  })

  it('rejects a short internal secret without revealing it', () => {
    const error = configError({
      NODE_ENV: 'test',
      BFF_INTERNAL_SECRET: 'not-a-secret',
    })

    assert.match(error.message, /BFF_INTERNAL_SECRET/)
    assert.equal(error.message.includes('not-a-secret'), false)
  })

  it('rejects an all-zero internal secret in production', () => {
    const error = configError({
      ...productionBase,
      BFF_INTERNAL_SECRET: Buffer.alloc(32).toString('base64'),
    })

    assert.match(error.message, /BFF_INTERNAL_SECRET/)
    assert.equal(error.message.includes('AAAA'), false)
  })

  it('rejects peer wildcards, networks, and host names without revealing them', () => {
    for (const peers of ['*', '10.0.0.0/8', 'localhost', '127.0.0.1,']) {
      const error = configError({
        NODE_ENV: 'test',
        BFF_TRUSTED_PEERS: peers,
      })

      assert.match(error.message, /BFF_TRUSTED_PEERS/)
      assert.equal(error.message.includes(peers), false)
    }
  })

  it('accepts an explicit production configuration', () => {
    const config = loadConfig(productionBase)

    assert.equal(config.nodeEnv, 'production')
    assert.equal(config.port, 8080)
    assert.equal(config.webOrigin, 'https://shop.example')
    assert.equal(config.supabaseUrl, 'https://project.supabase.co')
  })
})
