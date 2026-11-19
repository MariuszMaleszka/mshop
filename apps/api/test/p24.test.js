import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createP24Client } from '../src/p24/client.js'
import {
  jsonIntegerDigits,
  jsonNumberText,
  parseJsonWithIntegerStrings,
} from '../src/p24/json.js'
import { transactionPanelUrl } from '../src/p24/redirect.js'
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

  it('escapes backslash, quote, and newline without escaping a slash', () => {
    const statement = 'a\\b "ł"\n/'
    const documented =
      '{"merchantId":1,"posId":2,"sessionId":"a/b","amount":3,"originAmount":3,"currency":"PLN","orderId":1,"methodId":4,"statement":' +
      JSON.stringify(statement) +
      ',"crc":"crc"}'
    const sign = verifyTransactionNotification({
      merchantId: '1',
      posId: '2',
      sessionId: 'a/b',
      amount: '3',
      originAmount: '3',
      currency: 'PLN',
      orderId: '1',
      methodId: '4',
      statement,
      crc: CRC,
      sign: sha384(documented),
    })

    assert.equal(documented.includes('a\\\\b \\"ł\\"\\n/'), true)
    assert.equal(documented.includes('\\/'), false)
    assert.equal(sign, true)
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

  it('accepts the documented testAccess object and rejects a wrong data type', async () => {
    const valid = createP24Client(clientConfig(), {
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return '{"data":true,"error":"ok"}'
          },
        }
      },
    })
    const invalid = createP24Client(clientConfig(), {
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return '{"data":1}'
          },
        }
      },
    })

    assert.deepEqual(await valid.testAccess(), { data: true, error: 'ok' })
    await assert.rejects(() => invalid.testAccess(), /invalid data value/)
  })

  it('returns every documented transaction field without mapping the provider status', async () => {
    const client = createP24Client(clientConfig(), {
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return `{"responseCode":0,"data":{"statement":"tytuł / \\"a\\\\b\\"","orderId":${BIG_ORDER_ID},"sessionId":"session-1","status":2,"amount":1234,"currency":"PLN","date":"2026-01-01","dateOfTransaction":"2026-01-02","clientEmail":"a@b.co","accountMD5":"abc","paymentMethod":25,"description":"opis","clientName":"Jan","clientAddress":"Ul 1","clientCity":"Miasto","clientPostcode":"00-001","batchId":7,"fee":"0"}}`
          },
        }
      },
    })

    const result = await client.getTransactionBySessionId('session-1')

    assert.equal(result.orderId, BIG_ORDER_ID)
    assert.equal(typeof result.orderId, 'string')
    assert.equal(result.statement, 'tytuł / "a\\b"')
    assert.equal(result.status, '2')
    assert.equal(result.amount, '1234')
    assert.equal(result.paymentMethod, '25')
    assert.equal(result.batchId, '7')
    assert.equal(result.fee, '0')
    assert.equal(result.date, '2026-01-01')
    assert.equal(result.dateOfTransaction, '2026-01-02')
    assert.equal(result.paymentStatus, undefined)
  })

  it('keeps exact JSON number text and validates orderId as an integer field', async () => {
    const max = parseJsonWithIntegerStrings(`{"orderId":${BIG_ORDER_ID}}`)
    assert.equal(jsonIntegerDigits(max.orderId), BIG_ORDER_ID)

    const numbers = parseJsonWithIntegerStrings(
      '{"fraction":9223372036854775807.0,"exponent":1e20,"signed":1E+2,"cents":1.50,"whole":10}',
    )
    assert.equal(jsonNumberText(numbers.fraction), '9223372036854775807.0')
    assert.equal(jsonIntegerDigits(numbers.fraction), null)
    assert.equal(jsonNumberText(numbers.exponent), '1e20')
    assert.equal(jsonNumberText(numbers.signed), '1E+2')
    assert.equal(jsonNumberText(numbers.cents), '1.50')
    assert.equal(jsonIntegerDigits(numbers.whole), '10')

    for (const raw of [
      '{"orderId":01}',
      '{"orderId":1.}',
      '{"orderId":1e}',
      '{"orderId":+1}',
      '{"orderId":1,"orderId":2}',
      '{"data":{"orderId":1,"orderId":2}}',
      '{"data":{"nested":{"a":1,"a":2}}}',
    ]) {
      assert.throws(() => parseJsonWithIntegerStrings(raw), P24ResponseError)
    }

    for (const orderId of [
      '-1',
      '0',
      '"15"',
      '9223372036854775808',
      '9223372036854775807.0',
      '1e20',
    ]) {
      const client = createP24Client(clientConfig(), {
        async fetch() {
          return {
            ok: true,
            status: 200,
            async text() {
              return `{"responseCode":0,"data":{"orderId":${orderId},"sessionId":"session-1","status":0,"amount":1,"currency":"PLN"}}`
            },
          }
        },
      })

      await assert.rejects(
        () => client.getTransactionBySessionId('session-1'),
        (error) => {
          assert.equal(error instanceof P24ResponseError, true)
          assert.equal(error.message.includes('9223372036854775808'), false)
          return true
        },
      )
    }
  })

  it('times out while waiting for headers or the body and does not retry', async () => {
    const headerCalls = []
    const headerClient = createP24Client(
      { ...clientConfig(), requestTimeoutMs: 1000 },
      {
        fetch(_url, options) {
          headerCalls.push(1)
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          })
        },
      },
    )
    const bodyCalls = []
    const bodyClient = createP24Client(
      { ...clientConfig(), requestTimeoutMs: 1000 },
      {
        async fetch() {
          bodyCalls.push(1)
          return {
            ok: true,
            status: 200,
            text() {
              return new Promise(() => {})
            },
          }
        },
      },
    )

    await assert.rejects(() => headerClient.testAccess(), P24TimeoutError)
    await assert.rejects(() => bodyClient.testAccess(), P24TimeoutError)
    assert.equal(headerCalls.length, 1)
    assert.equal(bodyCalls.length, 1)
  })

  it('clears the timeout after the response body is read', async () => {
    const created = []
    const cleared = []
    const originalSet = globalThis.setTimeout
    const originalClear = globalThis.clearTimeout
    globalThis.setTimeout = (fn, ms, ...args) => {
      const id = originalSet(fn, ms, ...args)
      if (ms === 1000) {
        created.push(id)
      }
      return id
    }
    globalThis.clearTimeout = (id) => {
      cleared.push(id)
      return originalClear(id)
    }

    try {
      const client = createP24Client(
        { ...clientConfig(), requestTimeoutMs: 1000 },
        {
          async fetch() {
            return {
              ok: true,
              status: 200,
              async text() {
                return '{"data":true}'
              },
            }
          },
        },
      )

      assert.deepEqual(await client.testAccess(), { data: true })
      assert.equal(created.length, 1)
      assert.equal(cleared.includes(created[0]), true)
    } finally {
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    }
  })
})

describe('Przelewy24 redirect URL', () => {
  it('builds a fixed panel address for sandbox and production', () => {
    assert.equal(
      transactionPanelUrl('sandbox', 'token_1'),
      'https://sandbox.przelewy24.pl/trnRequest/token_1',
    )
    assert.equal(
      transactionPanelUrl('production', 'token_1'),
      'https://secure.przelewy24.pl/trnRequest/token_1',
    )
  })

  it('rejects an empty or invalid token before building a URL', () => {
    for (const token of [
      '',
      ' ',
      'a b',
      '../token',
      'token/extra',
      'token?next=https://evil.example',
      'https://evil.example/trnRequest/token_1',
      '%2F%2Fevil.example',
      '..',
      '.',
      `token_${'a'.repeat(2048)}`,
    ]) {
      assert.equal(transactionPanelUrl('sandbox', token), null, token)
      assert.equal(transactionPanelUrl('production', token), null, token)
    }

    assert.equal(transactionPanelUrl('sandbox', null), null)
    assert.equal(transactionPanelUrl('production', 1), null)
    assert.equal(transactionPanelUrl('other', 'token_1'), null)
  })
})
