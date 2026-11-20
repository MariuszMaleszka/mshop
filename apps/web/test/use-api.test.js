import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildApiUrl, requestApi } from '../app/composables/use-api.js'

const apiBase = 'http://localhost:3001/api/v1'

describe('API client', () => {
  it('joins a path to the configured API base', () => {
    assert.equal(
      buildApiUrl(apiBase, '/health'),
      'http://localhost:3001/api/v1/health',
    )
    assert.equal(
      buildApiUrl(apiBase, 'products?page=1'),
      'http://localhost:3001/api/v1/products?page=1',
    )
    assert.equal(buildApiUrl(apiBase, 'https://evil.example/cart'), null)
    assert.equal(buildApiUrl(apiBase, '/../secret'), null)
  })

  it('sends credentials and keeps a request without a body free of JSON content type', async () => {
    const calls = []
    const result = await requestApi(
      apiBase,
      '/health',
      {},
      {
        async fetch(url, options) {
          calls.push({ url, options })
          return jsonResponse(200, '{"data":{"status":"ok"},"meta":{}}')
        },
      },
    )

    assert.equal(calls[0].url, 'http://localhost:3001/api/v1/health')
    assert.equal(calls[0].options.credentials, 'include')
    assert.equal(calls[0].options.body, undefined)
    assert.equal(
      new Headers(calls[0].options.headers).has('content-type'),
      false,
    )
    assert.equal(result.error, null)
    assert.equal(result.status, 200)
    assert.deepEqual(result.data, { data: { status: 'ok' }, meta: {} })
  })

  it('returns null data for an empty success body', async () => {
    const result = await requestApi(
      apiBase,
      '/session/guest',
      { method: 'POST' },
      {
        async fetch() {
          return emptyResponse(204)
        },
      },
    )

    assert.deepEqual(result, { data: null, error: null, status: 204 })
  })

  it('returns the backend error code without its internal details', async () => {
    const result = await requestApi(
      apiBase,
      '/checkout',
      { method: 'POST' },
      {
        async fetch() {
          return jsonResponse(
            409,
            '{"error":{"code":"CART_EMPTY","message":"Cart is empty","details":["postgres://secret"]}}',
          )
        },
      },
    )

    assert.equal(result.data, null)
    assert.equal(result.status, 409)
    assert.deepEqual(result.error, {
      code: 'CART_EMPTY',
      message: 'Cart is empty',
    })
  })

  it('hides a network failure and an unreadable error body', async () => {
    const network = await requestApi(
      apiBase,
      '/health',
      {},
      {
        async fetch() {
          throw new Error('connect ECONNREFUSED 10.0.0.8 token=secret')
        },
      },
    )
    const unreadable = await requestApi(
      apiBase,
      '/health',
      {},
      {
        async fetch() {
          return {
            ok: false,
            status: 500,
            async text() {
              return '<html>stack trace token=secret</html>'
            },
          }
        },
      },
    )

    assert.deepEqual(network, {
      data: null,
      error: { code: 'NETWORK_ERROR', message: 'Network request failed' },
      status: 0,
    })
    assert.deepEqual(unreadable.error, {
      code: 'REQUEST_FAILED',
      message: 'Request failed',
    })
    assert.equal(JSON.stringify(network).includes('secret'), false)
    assert.equal(JSON.stringify(unreadable).includes('secret'), false)
  })

  it('forwards Idempotency-Key and Authorization without logging them', async () => {
    const calls = []
    const logs = []
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    }

    for (const name of Object.keys(original)) {
      console[name] = (...args) => {
        logs.push(args.map(String).join(' '))
      }
    }

    try {
      const result = await requestApi(
        apiBase,
        '/checkout',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer access-token',
            'Idempotency-Key': 'checkout-key-1',
            cookie: 'shop_guest_session=abc',
          },
          body: {
            email: 'anna@example.com',
            billing: { street: 'Lipowa' },
          },
        },
        {
          async fetch(_url, options) {
            calls.push(options)
            return jsonResponse(201, '{"data":{"id":"order-1"},"meta":{}}')
          },
        },
      )
      const headers = new Headers(calls[0].headers)

      assert.equal(result.error, null)
      assert.equal(headers.get('authorization'), 'Bearer access-token')
      assert.equal(headers.get('idempotency-key'), 'checkout-key-1')
      assert.equal(headers.get('content-type'), 'application/json')
      assert.equal(calls[0].credentials, 'include')
      assert.equal(logs.length, 0)
    } finally {
      Object.assign(console, original)
    }
  })
})

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body
    },
  }
}

function emptyResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return ''
    },
  }
}
