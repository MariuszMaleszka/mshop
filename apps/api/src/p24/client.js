import {
  P24DataError,
  P24HttpError,
  P24NetworkError,
  P24ResponseError,
  P24TimeoutError,
} from './errors.js'
import {
  canonicalJson,
  decimalInteger,
  encodeJsonString,
  parseJsonWithIntegerStrings,
} from './json.js'
import {
  signTransactionRegistration,
  signTransactionVerification,
} from './sign.js'

const URL_MAX = 250

export function createP24Client(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  assertClientConfig(config)

  async function request(path, { method, body }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
    let response

    try {
      response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: basicAuthorization(config.posId, config.secretId),
          accept: 'application/json',
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json; charset=utf-8' }),
        },
        body,
      })
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'TimeoutError') {
        throw new P24TimeoutError()
      }

      throw new P24NetworkError()
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()

    if (!response.ok) {
      throw new P24HttpError(response.status)
    }

    return parseJsonWithIntegerStrings(text)
  }

  return {
    async testAccess() {
      const body = await request('/testAccess', { method: 'GET' })
      const data = objectField(body, 'data')

      if (data !== true || body.responseCode !== '0') {
        throw new P24ResponseError(
          'Przelewy24 response is missing access status',
        )
      }

      return { data: true }
    },

    async registerTransaction(input) {
      const fields = registrationFields(config, input)
      const sign = signTransactionRegistration({
        sessionId: input.sessionId,
        merchantId: config.merchantId,
        amount: input.amount,
        currency: input.currency,
        crc: config.crcKey,
      })
      const body = await request('/transaction/register', {
        method: 'POST',
        body: canonicalJson([
          ...fields,
          ['sign', encodeJsonString(sign, 'sign')],
        ]),
      })
      const data = objectField(body, 'data')
      const token = data?.token

      if (
        body.responseCode !== '0' ||
        typeof token !== 'string' ||
        token.length < 1 ||
        token.length > 2048 ||
        /\s/.test(token)
      ) {
        throw new P24ResponseError('Przelewy24 response is missing a token')
      }

      return { token }
    },

    async getTransactionBySessionId(sessionId) {
      if (
        typeof sessionId !== 'string' ||
        sessionId.length < 1 ||
        sessionId.length > 100
      ) {
        throw new P24DataError(
          'sessionId must be a string of 1 to 100 characters',
        )
      }

      const body = await request(
        `/transaction/by/sessionId/${encodeURIComponent(sessionId)}`,
        { method: 'GET' },
      )
      const data = objectField(body, 'data')

      if (
        body.responseCode !== '0' ||
        !data ||
        data.sessionId !== sessionId ||
        !isDecimal(data.orderId) ||
        !isDecimal(data.status) ||
        !isDecimal(data.amount) ||
        typeof data.currency !== 'string'
      ) {
        throw new P24ResponseError(
          'Przelewy24 response is missing transaction data',
        )
      }

      return {
        orderId: data.orderId,
        sessionId: data.sessionId,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
      }
    },

    async verifyTransaction(input) {
      decimalInteger(input?.orderId, 'orderId')
      decimalInteger(input?.amount, 'amount')

      if (
        typeof input?.currency !== 'string' ||
        typeof input?.sessionId !== 'string'
      ) {
        throw new P24DataError('verification data must be text')
      }

      const sign = signTransactionVerification({
        sessionId: input.sessionId,
        orderId: input.orderId,
        amount: input.amount,
        currency: input.currency,
        crc: config.crcKey,
      })
      const body = await request('/transaction/verify', {
        method: 'PUT',
        body: canonicalJson([
          ['merchantId', decimalInteger(config.merchantId, 'merchantId')],
          ['posId', decimalInteger(config.posId, 'posId')],
          ['sessionId', encodeJsonString(input.sessionId, 'sessionId')],
          ['amount', decimalInteger(input.amount, 'amount')],
          ['currency', encodeJsonString(input.currency, 'currency')],
          ['orderId', decimalInteger(input.orderId, 'orderId')],
          ['sign', encodeJsonString(sign, 'sign')],
        ]),
      })
      const data = objectField(body, 'data')
      const status = data?.status

      if (
        body.responseCode !== '0' ||
        typeof status !== 'string' ||
        status.length < 1 ||
        status.length > 32
      ) {
        throw new P24ResponseError('Przelewy24 response is missing a status')
      }

      return { status }
    },
  }
}

function registrationFields(config, input) {
  requireText(input?.sessionId, 'sessionId', 1, 100)
  requireText(input?.description, 'description', 1, 1024)
  requireText(input?.email, 'email', 3, 50)
  requireText(input?.country, 'country', 2, 2)
  requireText(input?.language, 'language', 2, 2)
  requireUrl(input?.urlReturn, 'urlReturn', config.environment)
  requireUrl(input?.urlStatus, 'urlStatus', config.environment)
  decimalInteger(input?.amount, 'amount')

  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new P24DataError('currency must be a three-letter code')
  }

  const fields = [
    ['merchantId', decimalInteger(config.merchantId, 'merchantId')],
    ['posId', decimalInteger(config.posId, 'posId')],
    ['sessionId', encodeJsonString(input.sessionId, 'sessionId')],
    ['amount', decimalInteger(input.amount, 'amount')],
    ['currency', encodeJsonString(input.currency, 'currency')],
    ['description', encodeJsonString(input.description, 'description')],
    ['email', encodeJsonString(input.email, 'email')],
    ['country', encodeJsonString(input.country, 'country')],
    ['language', encodeJsonString(input.language, 'language')],
    ['urlReturn', encodeJsonString(input.urlReturn, 'urlReturn')],
    ['urlStatus', encodeJsonString(input.urlStatus, 'urlStatus')],
  ]

  if (input.timeLimit !== undefined) {
    const timeLimit = decimalInteger(input.timeLimit, 'timeLimit')

    if (BigInt(timeLimit) > 99n) {
      throw new P24DataError('timeLimit must be from 0 to 99')
    }

    fields.push(['timeLimit', timeLimit])
  }

  return fields
}

function assertClientConfig(config) {
  if (
    !config ||
    (config.environment !== 'sandbox' && config.environment !== 'production')
  ) {
    throw new P24DataError('Przelewy24 environment is invalid')
  }

  if (
    config.environment === 'sandbox' &&
    config.apiBaseUrl !== 'https://sandbox.przelewy24.pl/api/v1'
  ) {
    throw new P24DataError(
      'Przelewy24 sandbox URL does not match the environment',
    )
  }

  if (
    config.environment === 'production' &&
    config.apiBaseUrl !== 'https://secure.przelewy24.pl/api/v1'
  ) {
    throw new P24DataError(
      'Przelewy24 production URL does not match the environment',
    )
  }

  decimalInteger(config.merchantId, 'merchantId')
  decimalInteger(config.posId, 'posId')

  if (
    typeof config.crcKey !== 'string' ||
    typeof config.secretId !== 'string' ||
    config.crcKey.length < 1 ||
    config.secretId.length < 1 ||
    config.crcKey === config.secretId
  ) {
    throw new P24DataError('Przelewy24 credentials are invalid')
  }

  if (
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 1000 ||
    config.requestTimeoutMs > 60000
  ) {
    throw new P24DataError('Przelewy24 timeout is invalid')
  }
}

function basicAuthorization(posId, secretId) {
  return `Basic ${Buffer.from(`${posId}:${secretId}`, 'utf8').toString('base64')}`
}

function objectField(body, field) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new P24ResponseError('Przelewy24 response is not an object')
  }

  return body[field]
}

function requireText(value, field, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new P24DataError(`${field} must be a string`)
  }
}

function requireUrl(value, field, environment) {
  requireText(value, field, 1, URL_MAX)

  let url

  try {
    url = new URL(value)
  } catch {
    throw new P24DataError(`${field} must be an absolute URL`)
  }

  const protocolOk =
    url.protocol === 'https:' ||
    (environment === 'sandbox' && url.protocol === 'http:')

  if (!protocolOk) {
    throw new P24DataError(`${field} must use HTTPS`)
  }
}

function isDecimal(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}
