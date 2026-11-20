import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

const allowedOrigin = 'http://localhost:3000'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: allowedOrigin,
})

describe('CORS', () => {
  let server
  let baseUrl

  before(async () => {
    const app = createApp(config)

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })

    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('allows the configured origin with credentials', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { origin: allowedOrigin },
    })

    assert.equal(response.status, 200)
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      allowedOrigin,
    )
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      'true',
    )
    assertNoWildcard(response)
  })

  it('accepts an Idempotency-Key preflight from the configured origin', async () => {
    const response = await fetch(`${baseUrl}/api/v1/checkout`, {
      method: 'OPTIONS',
      headers: {
        origin: allowedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    })

    assert.equal(response.status, 204)
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      allowedOrigin,
    )
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      'true',
    )
    assert.equal(allowsHeader(response, 'Idempotency-Key'), true)
    assert.equal(allowsHeader(response, 'Content-Type'), true)
    assert.equal(allowsMethod(response, 'POST'), true)
    assert.equal(allowsMethod(response, 'OPTIONS'), true)
    assertNoWildcard(response)
  })

  it('accepts an Authorization preflight from the configured origin', async () => {
    const response = await fetch(`${baseUrl}/api/v1/cart`, {
      method: 'OPTIONS',
      headers: {
        origin: allowedOrigin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })

    assert.equal(response.status, 204)
    assert.equal(allowsHeader(response, 'Authorization'), true)
    assert.equal(allowsMethod(response, 'GET'), true)
    assert.equal(allowsMethod(response, 'PATCH'), true)
    assert.equal(allowsMethod(response, 'DELETE'), true)
    assertNoWildcard(response)
  })

  it('does not grant CORS headers to another origin', async () => {
    for (const origin of [
      'https://evil.example',
      'http://localhost:3000.evil.example',
      'http://localhost:3001',
    ]) {
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { origin },
      })
      const preflight = await fetch(`${baseUrl}/api/v1/checkout`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'idempotency-key',
        },
      })

      assert.equal(response.status, 200, origin)
      assert.equal(preflight.status, 204, origin)
      assert.equal(response.headers.get('access-control-allow-origin'), null)
      assert.equal(preflight.headers.get('access-control-allow-origin'), null)
      assert.equal(
        response.headers.get('access-control-allow-credentials'),
        null,
      )
      assert.equal(
        preflight.headers.get('access-control-allow-credentials'),
        null,
      )
      assert.equal(
        response.headers.get('access-control-allow-origin') === origin,
        false,
      )
      assertNoWildcard(response)
      assertNoWildcard(preflight)
    }
  })

  it('keeps a request without Origin unchanged', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(body, { data: { status: 'ok' }, meta: {} })
    assert.equal(response.headers.get('access-control-allow-origin'), null)
    assert.equal(response.headers.get('access-control-allow-credentials'), null)
    assertNoWildcard(response)
  })
})

function allowsHeader(response, name) {
  return headerList(response, 'access-control-allow-headers').includes(name)
}

function allowsMethod(response, name) {
  return headerList(response, 'access-control-allow-methods').includes(name)
}

function headerList(response, name) {
  return (response.headers.get(name) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function assertNoWildcard(response) {
  for (const value of response.headers.values()) {
    assert.equal(value.includes('*'), false)
  }
}
