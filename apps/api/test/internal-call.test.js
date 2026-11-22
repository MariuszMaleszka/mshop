import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import {
  authenticateInternalCall,
  authenticateInternalRequest,
  internalCallHttpResult,
} from '../src/http/internal-call.js'

const secret = randomBytes(32)
const secretText = secret.toString('base64')
const peers = ['127.0.0.1', '::1']

function call(overrides) {
  return authenticateInternalCall({
    remoteAddress: '127.0.0.1',
    secretHeader: secretText,
    clientIpHeader: '203.0.113.10',
    secret,
    trustedPeers: peers,
    ...overrides,
  })
}

describe('authenticateInternalCall', () => {
  it('accepts a trusted IPv4 peer and a canonical client address', () => {
    assert.deepEqual(call(), { ok: true, clientIp: '203.0.113.10' })
  })

  it('accepts an IPv6 peer and an IPv4-mapped peer', () => {
    assert.deepEqual(call({ remoteAddress: '::1' }), {
      ok: true,
      clientIp: '203.0.113.10',
    })
    assert.deepEqual(call({ remoteAddress: '::ffff:127.0.0.1' }), {
      ok: true,
      clientIp: '203.0.113.10',
    })
  })

  it('rejects an untrusted peer before trusting its secret', () => {
    const result = call({ remoteAddress: '192.0.2.20' })

    assert.deepEqual(result, { ok: false, reason: 'untrusted_peer' })
    assert.equal(JSON.stringify(result).includes(secretText), false)
  })

  it('rejects a trusted peer with a wrong or missing secret', () => {
    const wrong = call({ secretHeader: randomBytes(32).toString('base64') })
    const missing = call({ secretHeader: undefined })

    assert.equal(wrong.reason, 'invalid_secret')
    assert.equal(missing.reason, 'invalid_secret')
    assert.equal(JSON.stringify(wrong).includes(secretText), false)
  })

  it('rejects a missing secret, an empty peer list, and a missing peer list', () => {
    assert.equal(call({ secret: null }).reason, 'missing_config')
    assert.equal(call({ trustedPeers: [] }).reason, 'untrusted_peer')
    assert.equal(call({ trustedPeers: undefined }).reason, 'missing_config')
  })

  it('rejects a missing, invalid, or non-canonical client address', () => {
    assert.equal(
      call({ clientIpHeader: undefined }).reason,
      'missing_client_ip',
    )
    assert.equal(call({ clientIpHeader: '' }).reason, 'missing_client_ip')
    assert.equal(
      call({ clientIpHeader: 'not-an-ip' }).reason,
      'invalid_client_ip',
    )
    assert.equal(
      call({ clientIpHeader: '::ffff:203.0.113.10' }).reason,
      'invalid_client_ip',
    )
    assert.equal(
      call({ clientIpHeader: '203.0.113.010' }).reason,
      'invalid_client_ip',
    )
  })

  it('uses the socket address and ignores forwarded headers and req.ip', () => {
    const request = {
      ip: '192.0.2.20',
      headers: {
        'x-forwarded-for': '192.0.2.20',
        'x-mshop-client-ip': '203.0.113.10',
        'x-mshop-internal-secret': secretText,
      },
      socket: { remoteAddress: '198.51.100.8' },
    }
    const result = authenticateInternalRequest(request, {
      secret,
      trustedPeers: ['192.0.2.20'],
    })

    assert.deepEqual(result, { ok: false, reason: 'untrusted_peer' })
  })

  it('hides the failure reason and the secret in the HTTP result', () => {
    const body = JSON.stringify(internalCallHttpResult(call({ secret: null })))

    assert.equal(body.includes('missing_config'), false)
    assert.equal(body.includes(secretText), false)
    assert.equal(internalCallHttpResult(call()).status, 200)
  })

  it('does not write the secret to the console', () => {
    const lines = []
    const original = {
      log: console.log,
      error: console.error,
      info: console.info,
    }

    console.log = (line) => lines.push(String(line))
    console.error = (line) => lines.push(String(line))
    console.info = (line) => lines.push(String(line))

    try {
      call({ secretHeader: 'wrong' })
    } finally {
      console.log = original.log
      console.error = original.error
      console.info = original.info
    }

    assert.equal(lines.join('\n').includes(secretText), false)
  })
})

describe('internal call over HTTP', () => {
  it('reads the socket peer and ignores X-Forwarded-For', async () => {
    const server = createServer((request, response) => {
      const result = authenticateInternalRequest(request, {
        secret,
        trustedPeers: ['127.0.0.1'],
      })
      const httpResult = internalCallHttpResult(result)
      response.writeHead(httpResult.status, {
        'content-type': 'application/json',
      })
      response.end(JSON.stringify(httpResult.body))
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal`, {
        headers: {
          'x-forwarded-for': '192.0.2.20',
          'x-mshop-client-ip': '203.0.113.10',
          'x-mshop-internal-secret': secretText,
        },
      })
      const text = await response.text()

      assert.equal(response.status, 200)
      assert.equal(text, '{"clientIp":"203.0.113.10"}')
      assert.equal(text.includes(secretText), false)
      assert.equal(text.includes('192.0.2.20'), false)
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
