import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createP24Client } from '../src/p24/client.js'
import {
  P24DataError,
  P24HttpError,
  P24NetworkError,
  P24ResponseError,
  P24TimeoutError,
} from '../src/p24/errors.js'
import {
  signTransactionRegistration,
  signTransactionVerification,
  verifyTransactionNotification,
} from '../src/p24/sign.js'

const CRC = 'crc'
const REGISTRATION_JSON =
  '{"sessionId":"sessionId","merchantId":999999,"amount":1000,"currency":"PLN","crc":"crc"}'
const VERIFICATION_JSON =
  '{"sessionId":"sessionId","orderId":999999,"amount":1000,"currency":"PLN","crc":"crc"}'
const BIG_ORDER_ID = '9223372036854775807'
const NOTIFICATION_JSON = `{"merchantId":10,"posId":11,"sessionId":"a/b","amount":100,"originAmount":100,"currency":"PLN","orderId":${BIG_ORDER_ID},"methodId":1,"statement":"zażółć / \\"gęśl\\"","crc":"crc"}`

function sha384(value) {
  return createHash('sha384').update(value, 'utf8').digest('hex')
}

function sandboxEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    P24_ENVIRONMENT: 'sandbox',
    P24_MERCHANT_ID: '10001',
    P24_POS_ID: '10002',
    P24_CRC_KEY: 'sandbox-crc-key',
    P24_API_SECRET: 'sandbox-api-secret',
    ...overrides,
  }
}

function clientConfig() {
  return loadConfig(sandboxEnv()).p24
}

function registrationInput() {
  return {
    sessionId: '0f6d4c8a-1b2e-4f7a-9c3d-6e5a7b8c9d0e',
    amount: '1234',
    currency: 'PLN',
    description: 'Zamówienie Cabc',
    email: 'a@b.co',
    country: 'PL',
    language: 'pl',
    urlReturn: 'https://shop.example/return',
    urlStatus: 'https://shop.example/status',
  }
}

describe('Przelewy24 signatures', () => {
  it('signs registration with the documented field order and types', () => {
    const sign = signTransactionRegistration({
      sessionId: 'sessionId',
      merchantId: '999999',
      amount: '1000',
      currency: 'PLN',
      crc: CRC,
    })

    assert.equal(sign, sha384(REGISTRATION_JSON))
    assert.equal(sign, sign.toLowerCase())
    assert.equal(REGISTRATION_JSON.includes('"merchantId":999999'), true)
    assert.equal(REGISTRATION_JSON.includes('"amount":1000'), true)
  })

  it('signs the documented registration example', () => {
    const documented =
      '{"sessionId":"unikalne-id-sesji","merchantId":999999,"amount":1234,"currency":"PLN","crc":"crc-z-panelu-p24"}'
    const sign = signTransactionRegistration({
      sessionId: 'unikalne-id-sesji',
      merchantId: 999999n,
      amount: 1234n,
      currency: 'PLN',
      crc: 'crc-z-panelu-p24',
    })

    assert.equal(sign, sha384(documented))
  })

  it('signs verification with orderId between sessionId and amount', () => {
    const sign = signTransactionVerification({
      sessionId: 'sessionId',
      orderId: '999999',
      amount: '1000',
      currency: 'PLN',
      crc: CRC,
    })

    assert.equal(sign, sha384(VERIFICATION_JSON))
  })

  it('keeps an int64 orderId that JavaScript Number cannot represent', () => {
    const unsafe = Number(BIG_ORDER_ID)
    const sign = signTransactionVerification({
      sessionId: 'sessionId',
      orderId: BIG_ORDER_ID,
      amount: '1000',
      currency: 'PLN',
      crc: CRC,
    })
    const documented = `{"sessionId":"sessionId","orderId":${BIG_ORDER_ID},"amount":1000,"currency":"PLN","crc":"crc"}`

    assert.equal(Number.isSafeInteger(unsafe), false)
    assert.notEqual(String(unsafe), BIG_ORDER_ID)
    assert.equal(sign, sha384(documented))
    assert.throws(
      () =>
        signTransactionVerification({
          sessionId: 'sessionId',
          orderId: unsafe,
          amount: '1000',
          currency: 'PLN',
          crc: CRC,
        }),
      P24DataError,
    )
  })

  it('verifies a notification signature with unicode and a slash', () => {
    const fields = {
      merchantId: '10',
      posId: '11',
      sessionId: 'a/b',
      amount: '100',
      originAmount: '100',
      currency: 'PLN',
      orderId: BIG_ORDER_ID,
      methodId: '1',
      statement: 'zażółć / "gęśl"',
      crc: CRC,
    }

    assert.equal(
      verifyTransactionNotification({
        ...fields,
        sign: sha384(NOTIFICATION_JSON),
      }),
      true,
    )
    assert.equal(
      verifyTransactionNotification({
        ...fields,
        sign: sha384(REGISTRATION_JSON),
      }),
      false,
    )
    assert.equal(NOTIFICATION_JSON.includes('zażółć / \\"gęśl\\"'), true)
    assert.equal(NOTIFICATION_JSON.includes('\\/'), false)
  })

  it('rejects wrong types and does not echo them', () => {
    assert.throws(
      () =>
        signTransactionRegistration({
          sessionId: 'sessionId',
          merchantId: '999999',
          amount: 10.5,
          currency: 'PLN',
          crc: CRC,
        }),
      (error) => {
        assert.equal(error instanceof P24DataError, true)
        assert.equal(error.message.includes('10.5'), false)
        return true
      },
    )
    assert.throws(
      () =>
        verifyTransactionNotification({
          merchantId: '10',
          posId: '11',
          sessionId: 'a/b',
          amount: '100',
          originAmount: '100',
          currency: 'PLN',
          orderId: BIG_ORDER_ID,
          methodId: '1',
          statement: 12,
          crc: CRC,
          sign: 'a'.repeat(96),
        }),
      P24DataError,
    )
  })
})

describe('Przelewy24 configuration', () => {
  it('derives the sandbox URL and keeps the three secrets separate', () => {
    const p24 = clientConfig()

    assert.equal(p24.environment, 'sandbox')
    assert.equal(p24.merchantId, '10001')
    assert.equal(p24.posId, '10002')
    assert.equal(p24.crcKey, 'sandbox-crc-key')
    assert.equal(p24.secretId, 'sandbox-api-secret')
    assert.equal(p24.apiBaseUrl, 'https://sandbox.przelewy24.pl/api/v1')
    assert.equal(p24.requestTimeoutMs, 10000)
  })

  it('accepts production only when the process environment is production', () => {
    const p24 = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      WEB_ORIGIN: 'https://shop.example',
      DATABASE_URL:
        'postgresql://app:long-lived-db-password@db.internal:5432/shop',
      SUPABASE_URL: 'https://project.supabase.co',
      P24_ENVIRONMENT: 'production',
      P24_MERCHANT_ID: '10001',
      P24_POS_ID: '10002',
      P24_CRC_KEY: 'production-crc-key',
      P24_API_SECRET: 'production-api-secret',
      P24_REQUEST_TIMEOUT_MS: '15000',
    }).p24

    assert.equal(p24.environment, 'production')
    assert.equal(p24.apiBaseUrl, 'https://secure.przelewy24.pl/api/v1')
    assert.equal(p24.requestTimeoutMs, 15000)
  })

  it('rejects a sandbox environment in production without revealing the CRC key', () => {
    const crcKey = 'production-looking-crc'
    const { NODE_ENV: _nodeEnv, ...p24Env } = sandboxEnv({
      P24_CRC_KEY: crcKey,
    })
    let error

    try {
      loadConfig({
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://shop.example',
        DATABASE_URL:
          'postgresql://app:long-lived-db-password@db.internal:5432/shop',
        SUPABASE_URL: 'https://project.supabase.co',
        ...p24Env,
      })
    } catch (caught) {
      error = caught
    }

    assert.equal(_nodeEnv, 'development')
    assert.match(error.message, /P24_ENVIRONMENT/)
    assert.match(error.message, /production/)
    assert.equal(error.message.includes(crcKey), false)
  })

  it('rejects a production environment outside production', () => {
    const error = (() => {
      try {
        loadConfig(sandboxEnv({ P24_ENVIRONMENT: 'production' }))
      } catch (caught) {
        return caught
      }

      return null
    })()

    assert.match(error.message, /sandbox/)
  })

  it('rejects a partial configuration and identical secrets', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'development', P24_MERCHANT_ID: '10001' }),
      /P24_POS_ID/,
    )
    assert.throws(
      () =>
        loadConfig(
          sandboxEnv({
            P24_CRC_KEY: 'same-secret-value',
            P24_API_SECRET: 'same-secret-value',
          }),
        ),
      /P24_CRC_KEY/,
    )
  })
})

describe('Przelewy24 HTTP client', () => {
  it('sends Basic auth with posId and secretId and does not retry', async () => {
    const calls = []
    const config = clientConfig()
    const client = createP24Client(config, {
      async fetch(url, options) {
        calls.push({ url, options })
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: { token: 'token-1' },
              responseCode: 0,
            })
          },
        }
      },
    })

    const result = await client.registerTransaction(registrationInput())
    const body = calls[0].options.body

    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.method, 'POST')
    assert.equal(
      calls[0].url,
      'https://sandbox.przelewy24.pl/api/v1/transaction/register',
    )
    assert.equal(
      calls[0].options.headers.authorization,
      `Basic ${Buffer.from('10002:sandbox-api-secret', 'utf8').toString('base64')}`,
    )
    assert.equal(body.includes('sandbox-api-secret'), false)
    assert.equal(body.includes('sandbox-crc-key'), false)
    assert.equal(body.includes('"merchantId":10001'), true)
    assert.equal(body.includes('"posId":10002'), true)
    assert.equal(result.token, 'token-1')
  })

  it('returns provider status text without mapping it to an order', async () => {
    const client = createP24Client(clientConfig(), {
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: { status: 'success' },
              responseCode: 0,
            })
          },
        }
      },
    })

    const result = await client.verifyTransaction({
      sessionId: 'session-1',
      orderId: BIG_ORDER_ID,
      amount: '1234',
      currency: 'PLN',
    })

    assert.deepEqual(result, { status: 'success' })
    assert.equal(result.paymentStatus, undefined)
  })

  it('preserves a large orderId from transaction lookup', async () => {
    const client = createP24Client(clientConfig(), {
      async fetch(url) {
        assert.equal(url.endsWith('/transaction/by/sessionId/session-1'), true)
        return {
          ok: true,
          status: 200,
          async text() {
            return `{"data":{"statement":"tytul","orderId":${BIG_ORDER_ID},"sessionId":"session-1","status":2,"amount":1234,"currency":"PLN"},"responseCode":0}`
          },
        }
      },
    })

    const result = await client.getTransactionBySessionId('session-1')

    assert.equal(result.orderId, BIG_ORDER_ID)
    assert.equal(result.status, '2')
    assert.equal(result.amount, '1234')
    assert.equal(result.currency, 'PLN')
  })

  it('reports HTTP 400 and 401 without the response body', async () => {
    for (const status of [400, 401]) {
      const calls = []
      const client = createP24Client(clientConfig(), {
        async fetch() {
          calls.push(1)
          return {
            ok: false,
            status,
            async text() {
              return JSON.stringify({
                error: 'Invalid input data',
                code: status,
                email: 'hidden@example.com',
              })
            },
          }
        },
      })

      await assert.rejects(
        () => client.testAccess(),
        (error) => {
          assert.equal(error instanceof P24HttpError, true)
          assert.equal(error.status, status)
          assert.equal(error.message.includes('hidden@example.com'), false)
          assert.equal(error.message.includes('Invalid input data'), false)
          return true
        },
      )
      assert.equal(calls.length, 1)
    }
  })

  it('distinguishes timeout and a dropped connection', async () => {
    const timeoutClient = createP24Client(clientConfig(), {
      async fetch() {
        const error = new Error('aborted')
        error.name = 'TimeoutError'
        throw error
      },
    })
    const networkClient = createP24Client(clientConfig(), {
      async fetch() {
        throw new TypeError('fetch failed')
      },
    })

    await assert.rejects(() => timeoutClient.testAccess(), P24TimeoutError)
    await assert.rejects(() => networkClient.testAccess(), P24NetworkError)
  })

  it('rejects invalid JSON and a success body without a token or status', async () => {
    const invalid = createP24Client(clientConfig(), {
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return '{"data":'
          },
        }
      },
    })
    const withoutToken = createP24Client(clientConfig(), {
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: {}, responseCode: 0 })
          },
        }
      },
    })
    const withoutStatus = createP24Client(clientConfig(), {
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: {}, responseCode: 0 })
          },
        }
      },
    })

    await assert.rejects(() => invalid.testAccess(), P24ResponseError)
    await assert.rejects(
      () => withoutToken.registerTransaction(registrationInput()),
      /missing a token/,
    )
    await assert.rejects(
      () =>
        withoutStatus.verifyTransaction({
          sessionId: 'session-1',
          orderId: '15',
          amount: '10',
          currency: 'PLN',
        }),
      /missing a status/,
    )
  })
})
