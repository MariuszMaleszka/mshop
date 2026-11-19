import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { createLogger } from '../src/http/logger.js'
import { loadConfig } from '../src/config.js'
import {
  PAYMENT_ADVISORY_LOCK_NAMESPACE,
  paymentAdvisoryLockKey,
} from '../src/checkout/payment-lock.js'
import {
  P24_WEBHOOK_BODY_LIMIT,
  P24_WEBHOOK_PATH,
  registerP24WebhookRoutes,
} from '../src/p24/webhook-routes.js'

const CRC = 'crc-test-secret'
const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const BIG_ORDER_ID = '9223372036854775807'
const STATEMENT = 'payer-secret-statement'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})
const p24 = {
  merchantId: '10',
  posId: '11',
  crcKey: CRC,
}

const lines = []
const storedEvents = []
const calls = {
  query: 0,
  verify: 0,
  lock: 0,
  namespace: null,
  key: null,
  insertedBeforeVerify: false,
  verifyInput: null,
}
let server
let baseUrl

function sha384(value) {
  return createHash('sha384').update(value, 'utf8').digest('hex')
}

function notificationSign(fields) {
  return sha384(
    `{"merchantId":${fields.merchantId},"posId":${fields.posId},"sessionId":${JSON.stringify(fields.sessionId)},"amount":${fields.amount},"originAmount":${fields.originAmount},"currency":${JSON.stringify(fields.currency)},"orderId":${fields.orderId},"methodId":${fields.methodId},"statement":${JSON.stringify(fields.statement)},"crc":${JSON.stringify(CRC)}}`,
  )
}

function fields(overrides = {}) {
  return {
    merchantId: '10',
    posId: '11',
    sessionId: SESSION_ID,
    amount: '100',
    originAmount: '100',
    currency: 'PLN',
    orderId: BIG_ORDER_ID,
    methodId: '1',
    statement: STATEMENT,
    ...overrides,
  }
}

const RAW_FIELDS = new Set([
  'merchantId',
  'posId',
  'amount',
  'originAmount',
  'orderId',
  'methodId',
])

function encodeBody(input, options = {}) {
  const sign = Object.hasOwn(options, 'sign')
    ? options.sign
    : notificationSign(input)
  const entries = Object.entries(input).filter(
    ([, value]) => value !== undefined,
  )
  const parts = entries.map(([key, value]) => {
    const encoded = RAW_FIELDS.has(key) ? value : JSON.stringify(value)
    return `${JSON.stringify(key)}:${encoded}`
  })

  if (typeof sign === 'string') {
    parts.push(`${JSON.stringify('sign')}:${JSON.stringify(sign)}`)
  }

  if (options.extra) {
    parts.push(
      `${JSON.stringify(options.extra.key)}:${JSON.stringify(options.extra.value)}`,
    )
  }

  return `{${parts.join(',')}}`
}

async function post(body, headers = {}) {
  const response = await fetch(`${baseUrl}${P24_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body,
  })
  const text = await response.text()
  let payload = null

  if (text) {
    payload = JSON.parse(text)
  }

  return { status: response.status, payload, text }
}

describe('Przelewy24 notification webhook', () => {
  beforeEach(() => {
    calls.query = 0
    calls.verify = 0
    calls.lock = 0
    calls.namespace = null
    calls.key = null
    calls.insertedBeforeVerify = false
    calls.verifyInput = null
    calls.inserted = false
    storedEvents.length = 0
    lines.length = 0
  })

  before(async () => {
    const logger = createLogger({
      nodeEnv: 'development',
      write(_level, line) {
        lines.push(line)
      },
    })
    const database = {
      async withSessionLock(namespace, key, work) {
        calls.lock += 1
        calls.namespace = namespace
        calls.key = key
        return work({
          transaction(callback) {
            return callback({
              async query(text, params = []) {
                calls.query += 1
                if (text.includes('inventory_reservations')) {
                  return { rows: [], rowCount: 0 }
                }
                if (text.includes('UPDATE public.')) {
                  return { rows: [{ id: SESSION_ID }], rowCount: 1 }
                }
                if (
                  text.includes('INSERT') &&
                  text.includes('payment_events')
                ) {
                  calls.inserted = true
                  const payload = JSON.parse(params[2])
                  storedEvents.push({
                    event_type: params[1],
                    session_id: payload.sessionId ?? null,
                    order_id: payload.orderId ?? null,
                    amount: payload.amount ?? null,
                    origin_amount: payload.originAmount ?? null,
                    currency: payload.currency ?? null,
                    method_id: payload.methodId ?? null,
                  })
                  return { rows: [], rowCount: 1 }
                }
                if (text.includes('INSERT')) {
                  return { rows: [], rowCount: 1 }
                }
                if (text.includes('payment_events')) {
                  return { rows: storedEvents }
                }
                if (text.includes('FROM public.orders')) {
                  return {
                    rows: [
                      {
                        id: '22222222-2222-4222-8222-222222222222',
                        payment_status: 'pending',
                      },
                    ],
                  }
                }

                return {
                  rows: [
                    {
                      id: SESSION_ID,
                      provider: 'przelewy24',
                      status: 'pending',
                      amount: '100',
                      currency: 'PLN',
                      provider_transaction_id: null,
                      order_id: '22222222-2222-4222-8222-222222222222',
                      payment_status: 'pending',
                    },
                  ],
                }
              },
            })
          },
        })
      },
    }
    const app = createApp(config, {
      logger,
      database,
      registerRoutes(router) {
        registerP24WebhookRoutes(router, {
          p24,
          database,
          verifyTransaction(input) {
            calls.verify += 1
            calls.verifyInput = input
            calls.insertedBeforeVerify = calls.inserted === true
            return { status: 'success' }
          },
        })
      },
    })
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  })

  it('accepts a signed notification and keeps the int64 orderId as text', async () => {
    const body = encodeBody(fields())
    const result = await post(body)

    assert.equal(result.status, 202)
    assert.equal(result.payload.data.status, 'accepted')
    assert.equal(result.payload.data.orderId, BIG_ORDER_ID)
    assert.equal(result.payload.data.amount, '100')
    assert.equal(result.payload.data.originAmount, '100')
    assert.equal(result.text.includes(STATEMENT), false)
    assert.equal(result.text.includes(CRC), false)
    assert.equal(calls.lock, 1)
    assert.equal(calls.namespace, PAYMENT_ADVISORY_LOCK_NAMESPACE)
    assert.equal(calls.key, paymentAdvisoryLockKey(SESSION_ID))
    assert.equal(calls.verify, 1)
    assert.equal(calls.insertedBeforeVerify, true)
    assert.equal(calls.verifyInput.orderId, BIG_ORDER_ID)
    assert.equal(typeof calls.verifyInput.amount, 'string')
    assert.equal(calls.verifyInput.merchantId, '10')
    assert.equal(calls.verifyInput.posId, '11')
    assert.equal(
      lines.some((line) => line.includes(STATEMENT)),
      false,
    )
    assert.equal(
      lines.some((line) => line.includes(CRC)),
      false,
    )
  })

  it('rejects a wrong signature without a database or P24 call', async () => {
    const result = await post(encodeBody(fields(), { sign: 'a'.repeat(96) }))

    assert.equal(result.status, 400)
    assert.equal(result.payload.error.code, 'VALIDATION_ERROR')
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
    assert.equal(
      lines.some((line) => line.includes(STATEMENT)),
      false,
    )
    assert.equal(
      lines.some((line) => line.includes('a'.repeat(96))),
      false,
    )
  })

  it('rejects an uppercase signature', async () => {
    const sign = notificationSign(fields()).toUpperCase()
    const result = await post(encodeBody(fields(), { sign }))

    assert.equal(result.status, 400)
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })

  it('rejects a body that omits any signed field', async () => {
    for (const key of Object.keys(fields())) {
      const input = fields({ [key]: undefined })
      const result = await post(encodeBody(input))

      assert.equal(result.status, 400, key)
      assert.equal(calls.query, 0)
      assert.equal(calls.verify, 0)
    }

    const missingSign = await post(encodeBody(fields(), { sign: null }))
    assert.equal(missingSign.status, 400)
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })

  it('rejects duplicate JSON keys', async () => {
    const result = await post('{"merchantId":10,"merchantId":11}')

    assert.equal(result.status, 400)
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })

  it('rejects fractions, exponents, negatives, and leading zeros', async () => {
    const samples = [
      encodeBody(fields()).replace('"amount":100', '"amount":1.50'),
      encodeBody(fields()).replace('"amount":100', '"amount":1e2'),
      encodeBody(fields()).replace('"amount":100', '"amount":-100'),
      encodeBody(fields()).replace('"methodId":1', '"methodId":01'),
    ]

    for (const body of samples) {
      const result = await post(body)
      assert.equal(result.status, 400)
      assert.equal(calls.query, 0)
      assert.equal(calls.verify, 0)
    }
  })

  it('rejects an orderId above int64', async () => {
    const result = await post(
      encodeBody(fields({ orderId: '9223372036854775808' })),
    )

    assert.equal(result.status, 400)
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })

  it('rejects a sessionId that is not a UUID', async () => {
    const result = await post(encodeBody(fields({ sessionId: 'not-a-uuid' })))

    assert.equal(result.status, 400)
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })

  it('rejects a different merchantId or posId', async () => {
    const merchant = await post(encodeBody(fields({ merchantId: '99' })))
    const pos = await post(encodeBody(fields({ posId: '99' })))

    assert.equal(merchant.status, 400)
    assert.equal(pos.status, 400)
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })

  it('ignores an unknown field and does not return it', async () => {
    const result = await post(
      encodeBody(fields(), { extra: { key: 'note', value: 'ignore-me' } }),
    )

    assert.equal(result.status, 202)
    assert.equal(result.text.includes('ignore-me'), false)
    assert.equal(result.text.includes(STATEMENT), false)
    assert.equal(calls.lock, 1)
    assert.equal(calls.verify, 1)
  })

  it('accepts an empty statement', async () => {
    const result = await post(encodeBody(fields({ statement: '' })))

    assert.equal(result.status, 202)
    assert.equal(result.payload.data.orderId, BIG_ORDER_ID)
    assert.equal(calls.lock, 1)
    assert.equal(calls.verify, 1)
    assert.equal(result.text.includes(STATEMENT), false)
  })

  it('rejects a body above the limit', async () => {
    const result = await post(Buffer.alloc(P24_WEBHOOK_BODY_LIMIT + 1, 0x61))

    assert.equal(result.status, 413)
    assert.equal(result.payload.error.code, 'PAYLOAD_TOO_LARGE')
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })

  it('rejects invalid JSON', async () => {
    const result = await post('{')

    assert.equal(result.status, 400)
    assert.equal(result.payload.error.code, 'VALIDATION_ERROR')
    assert.equal(calls.query, 0)
    assert.equal(calls.verify, 0)
  })
})
