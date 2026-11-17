import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose'
import { JWKSNoMatchingKey, JWKSTimeout } from 'jose/errors'
import { requireAuth } from '../src/auth/require-auth.js'
import { createAccessTokenVerifier, supabaseJwksUrl } from '../src/auth/tokens.js'
import { createApp } from '../src/app.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const supabaseUrl = 'http://127.0.0.1:54321'
const issuer = `${supabaseUrl}/auth/v1`
const userId = '11111111-1111-4111-8111-111111111111'

let publicJwk
let privateKey
let otherPrivateKey

before(async () => {
  const primary = await generateKeyPair('ES256', { extractable: true })
  const secondary = await generateKeyPair('ES256', { extractable: true })
  privateKey = primary.privateKey
  otherPrivateKey = secondary.privateKey
  publicJwk = await exportJWK(primary.publicKey)
  publicJwk.kid = 'test-es256'
  publicJwk.alg = 'ES256'
  publicJwk.use = 'sig'
})

function localJwks() {
  return async function resolveKey(protectedHeader) {
    if (protectedHeader.kid !== publicJwk.kid) {
      throw new JWKSNoMatchingKey()
    }

    return importJWK(publicJwk, 'ES256')
  }
}

function verifierWith(jwks = localJwks()) {
  return createAccessTokenVerifier({
    supabaseUrl,
    jwks,
  })
}

async function signToken(key, { header = {}, claims = {}, subject = userId } = {}) {
  const token = new SignJWT(claims)
    .setProtectedHeader({
      alg: 'ES256',
      kid: publicJwk.kid,
      ...header,
    })
    .setIssuer(issuer)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('2m')

  if (subject !== null) {
    token.setSubject(subject)
  }

  return token.sign(key)
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

async function send(verifier, path, { authorization, database } = {}) {
  const lines = []
  const logger = createLogger({
    nodeEnv: 'development',
    write(_level, line) {
      lines.push(line)
    },
  })
  const app = createApp(config, {
    logger,
    database,
    accessTokens: verifier,
    registerRoutes(router) {
      router.get('/api/v1/protected', requireAuth(verifier), (req, res) => {
        res.status(200).json({
          data: {
            userId: req.auth.userId,
            hasToken: Object.hasOwn(req.auth, 'token'),
          },
          meta: {},
        })
      })
    },
  })
  const { server, baseUrl } = await listen(app)

  try {
    const headers = authorization === undefined ? {} : { authorization }
    const response = await fetch(`${baseUrl}${path}`, { headers })
    const body = await response.json()
    return { status: response.status, body, lines }
  } finally {
    await close(server)
  }
}

function assertNoSecrets(result, secrets) {
  const published = JSON.stringify({ body: result.body, lines: result.lines })

  for (const secret of secrets) {
    assert.equal(published.includes(secret), false)
  }
}

describe('access token authentication', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const result = await send(verifierWith(), '/api/v1/protected')

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(result.body.error.message, 'Authentication required')
    assert.match(result.lines.join('\n'), /auth\.missing_token/)
  })

  it('returns 401 for a non-bearer scheme', async () => {
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: 'Basic abc',
    })

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(publishedIncludes(result, 'Basic abc'), false)
  })

  it('returns 401 for a malformed token', async () => {
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: 'Bearer not-a-jwt',
    })

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assertNoSecrets(result, ['not-a-jwt', 'ERR_JWT', 'jose'])
  })

  it('exposes the verified user id', async () => {
    const token = await signToken(privateKey)
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 200)
    assert.deepEqual(result.body, {
      data: { userId, hasToken: false },
      meta: {},
    })
    assertNoSecrets(result, [token])
  })

  it('accepts an RS256 token from the allowlist', async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    const rsaJwk = await exportJWK(pair.publicKey)
    rsaJwk.kid = 'test-rs256'
    rsaJwk.alg = 'RS256'
    rsaJwk.use = 'sig'
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: rsaJwk.kid })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(pair.privateKey)
    const verifier = createAccessTokenVerifier({
      supabaseUrl,
      jwks: async (protectedHeader) => {
        if (protectedHeader.kid !== rsaJwk.kid) {
          throw new JWKSNoMatchingKey()
        }

        return importJWK(rsaJwk, 'RS256')
      },
    })
    const result = await send(verifier, '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 200)
    assert.equal(result.body.data.userId, userId)
  })

  it('returns 401 for an expired token', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey)
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assertNoSecrets(result, [token, 'claim timestamp', 'ERR_JWT_EXPIRED'])
  })

  it('returns 401 when exp is missing', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setIssuedAt()
      .sign(privateKey)
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
    assert.equal(result.body.error.message, 'Authentication required')
    assertNoSecrets(result, [token, 'missing required'])
  })

  it('returns 401 for a signature from another key', async () => {
    const token = await signToken(otherPrivateKey)
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assertNoSecrets(result, [token, 'signature verification failed'])
  })

  it('returns 401 for a different issuer', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .setSubject(userId)
      .setIssuer('https://evil.example/auth/v1')
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey)
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assertNoSecrets(result, [token, 'evil.example'])
  })

  it('returns 401 for a different audience', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience('anon')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey)
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 401 when sub is missing', async () => {
    const token = await signToken(privateKey, { subject: null })
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assert.match(result.lines.join('\n'), /auth\.invalid_subject/)
  })

  it('returns 401 when sub is not a UUID', async () => {
    const token = await signToken(privateKey, { subject: 'not-a-uuid' })
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assertNoSecrets(result, ['not-a-uuid'])
  })

  it('returns 401 for an algorithm outside the allowlist', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'shared' })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(new TextEncoder().encode('test-only-hmac-secret'))
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assertNoSecrets(result, [token, 'test-only-hmac-secret', 'HS256', 'alg'])
  })

  it('returns 401 when the fetched JWKS has no matching kid', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'missing-kid' })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(otherPrivateKey)
    const result = await send(verifierWith(), '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 401)
    assertNoSecrets(result, [token, 'no applicable key', 'missing-kid'])
  })

  it('returns 503 when JWKS cannot be fetched', async () => {
    const token = await signToken(privateKey)
    const verifier = createAccessTokenVerifier({
      supabaseUrl,
      jwks: async () => {
        throw new TypeError(
          'fetch failed http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
        )
      },
    })
    const result = await send(verifier, '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 503)
    assert.deepEqual(result.body, {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable',
        details: [],
      },
    })
    assert.match(result.lines.join('\n'), /auth\.jwks_unavailable/)
    assertNoSecrets(result, [
      token,
      'well-known',
      '54321',
      'fetch failed',
      'JWKSTimeout',
    ])
  })

  it('returns 503 for a JWKS timeout without treating it as a bad token', async () => {
    const token = await signToken(privateKey)
    const verifier = createAccessTokenVerifier({
      supabaseUrl,
      jwks: async () => {
        throw new JWKSTimeout()
      },
    })
    const result = await send(verifier, '/api/v1/protected', {
      authorization: `Bearer ${token}`,
    })

    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE')
    assertNoSecrets(result, [token, 'request timed out'])
  })

  it('keeps health and readiness public', async () => {
    const result = await send(verifierWith(), '/api/v1/health')
    const ready = await send(verifierWith(), '/api/v1/health/ready', {
      database: { async checkConnection() { return true } },
    })

    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { data: { status: 'ok' }, meta: {} })
    assert.equal(ready.status, 200)
    assert.deepEqual(ready.body, { data: { status: 'ready' }, meta: {} })
  })

  it('builds one JWKS resolver and normalizes the issuer URL', () => {
    const calls = []
    createAccessTokenVerifier({
      supabaseUrl: 'http://127.0.0.1:54321///',
      createJwks(url, options) {
        calls.push({ url, options })
        return localJwks()
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url.href, supabaseJwksUrl(supabaseUrl).href)
    assert.deepEqual(calls[0].options, {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    })
  })

  it('does not call JWKS when Supabase is not configured', async () => {
    let called = false
    const verifier = createAccessTokenVerifier({
      supabaseUrl: null,
      createJwks() {
        called = true
        return localJwks()
      },
    })

    await assert.rejects(verifier.verifyAccessToken('header.payload.signature'), (error) => {
      assert.equal(error.status, 503)
      assert.equal(error.logMessage, 'auth.not_configured')
      return true
    })
    assert.equal(called, false)
  })
})

function publishedIncludes(result, secret) {
  return JSON.stringify({ body: result.body, lines: result.lines }).includes(secret)
}
