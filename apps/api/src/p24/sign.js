import { createHash, timingSafeEqual } from 'node:crypto'
import { P24DataError } from './errors.js'
import { canonicalJson, decimalInteger, encodeJsonString } from './json.js'

function sha384Hex(value) {
  return createHash('sha384').update(value, 'utf8').digest('hex')
}

function sessionId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    throw new P24DataError('sessionId must be a string of 1 to 100 characters')
  }

  return encodeJsonString(value, 'sessionId')
}

function currency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new P24DataError('currency must be a three-letter code')
  }

  return encodeJsonString(value, 'currency')
}

function crc(value) {
  if (typeof value !== 'string' || value.length < 1 || /\s/.test(value)) {
    throw new P24DataError('crc must be a string')
  }

  return encodeJsonString(value, 'crc')
}

function integer(value, field) {
  return decimalInteger(value, field)
}

export function signTransactionRegistration({
  sessionId: session,
  merchantId,
  amount,
  currency: currencyCode,
  crc: crcKey,
}) {
  const encoded = canonicalJson([
    ['sessionId', sessionId(session)],
    ['merchantId', integer(merchantId, 'merchantId')],
    ['amount', integer(amount, 'amount')],
    ['currency', currency(currencyCode)],
    ['crc', crc(crcKey)],
  ])

  return sha384Hex(encoded)
}

export function signTransactionVerification({
  sessionId: session,
  orderId,
  amount,
  currency: currencyCode,
  crc: crcKey,
}) {
  const encoded = canonicalJson([
    ['sessionId', sessionId(session)],
    ['orderId', integer(orderId, 'orderId')],
    ['amount', integer(amount, 'amount')],
    ['currency', currency(currencyCode)],
    ['crc', crc(crcKey)],
  ])

  return sha384Hex(encoded)
}

export function verifyTransactionNotification({
  merchantId,
  posId,
  sessionId: session,
  amount,
  originAmount,
  currency: currencyCode,
  orderId,
  methodId,
  statement,
  crc: crcKey,
  sign,
}) {
  if (typeof statement !== 'string') {
    throw new P24DataError('statement must be a string')
  }

  const encoded = canonicalJson([
    ['merchantId', integer(merchantId, 'merchantId')],
    ['posId', integer(posId, 'posId')],
    ['sessionId', sessionId(session)],
    ['amount', integer(amount, 'amount')],
    ['originAmount', integer(originAmount, 'originAmount')],
    ['currency', currency(currencyCode)],
    ['orderId', integer(orderId, 'orderId')],
    ['methodId', integer(methodId, 'methodId')],
    ['statement', encodeJsonString(statement, 'statement')],
    ['crc', crc(crcKey)],
  ])
  const expected = sha384Hex(encoded)

  if (typeof sign !== 'string' || !/^[0-9a-f]{96}$/.test(sign)) {
    return false
  }

  return timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(sign, 'utf8'),
  )
}
