import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  browserFacingInternalResult,
  prepareInternalCall,
  prepareInternalCallFromRequest,
  serverInternalSecret,
} from '../server/utils/internal-call.js'

const secret = randomBytes(32).toString('base64')

describe('prepareInternalCall', () => {
  it('sends the canonical socket address and the server secret', () => {
    const result = prepareInternalCall({
      remoteAddress: '::ffff:203.0.113.10',
      secret,
    })

    assert.equal(result.ok, true)
    assert.equal(result.clientIp, '203.0.113.10')
    assert.equal(result.headers['x-mshop-client-ip'], '203.0.113.10')
    assert.equal(result.headers['x-mshop-internal-secret'], secret)
  })

  it('accepts IPv4 and IPv6 socket addresses', () => {
    assert.equal(
      prepareInternalCall({ remoteAddress: '127.0.0.1', secret }).clientIp,
      '127.0.0.1',
    )
    assert.equal(
      prepareInternalCall({ remoteAddress: '::1', secret }).clientIp,
      '::1',
    )
  })

  it('reads only the socket and ignores client-supplied addresses', () => {
    const result = prepareInternalCallFromRequest(
      {
        headers: {
          'x-forwarded-for': '192.0.2.20',
          'x-mshop-client-ip': '198.51.100.8',
        },
        socket: { remoteAddress: '203.0.113.10' },
      },
      { secret },
    )

    assert.equal(result.clientIp, '203.0.113.10')
    assert.equal(JSON.stringify(result).includes('192.0.2.20'), false)
  })

  it('rejects a missing address, an invalid address, and a missing secret', () => {
    const missing = prepareInternalCall({ remoteAddress: undefined, secret })
    const invalid = prepareInternalCall({ remoteAddress: 'nope', secret })
    const leaked = 'not-a-secret'
    const unconfigured = prepareInternalCall({
      remoteAddress: '203.0.113.10',
      secret: leaked,
    })

    assert.equal(missing.reason, 'missing_client_ip')
    assert.equal(invalid.reason, 'invalid_client_ip')
    assert.equal(unconfigured.reason, 'missing_config')
    assert.equal(JSON.stringify(unconfigured).includes(leaked), false)
    assert.equal(unconfigured.headers, undefined)
  })

  it('reads the private runtime secret and not the public config', () => {
    assert.equal(
      serverInternalSecret({
        bffInternalSecret: secret,
        public: { bffInternalSecret: 'public-secret-value' },
      }),
      secret,
    )
    assert.equal(
      serverInternalSecret({
        bffInternalSecret: '',
        public: { bffInternalSecret: secret },
      }),
      null,
    )
  })

  it('does not put the secret in a browser-facing result', () => {
    const prepared = prepareInternalCall({
      remoteAddress: '203.0.113.10',
      secret,
    })
    const visible = JSON.stringify(browserFacingInternalResult(prepared))

    assert.equal(visible.includes(secret), false)
    assert.equal(visible.includes('x-mshop-internal-secret'), false)
    assert.deepEqual(browserFacingInternalResult({ ok: false }), {
      ok: false,
      code: 'forbidden',
    })
  })
})
