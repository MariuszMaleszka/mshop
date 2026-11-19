import { HttpError } from '../http/errors.js'
import { P24DataError, P24ResponseError } from './errors.js'
import {
  decimalInteger,
  jsonIntegerDigits,
  parseJsonWithIntegerStrings,
} from './json.js'
import { verifyTransactionNotification } from './sign.js'

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INT64_MAX = 9223372036854775807n

export function readPaymentNotification(text, p24) {
  if (!hasNotificationConfig(p24)) {
    throw new HttpError({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
      logMessage: 'p24.notification_unconfigured',
    })
  }

  const body = parsedObject(text)
  const notification = {
    merchantId: requiredInteger(body, 'merchantId'),
    posId: requiredInteger(body, 'posId'),
    sessionId: requiredText(body, 'sessionId'),
    amount: requiredInteger(body, 'amount'),
    originAmount: requiredInteger(body, 'originAmount'),
    currency: requiredText(body, 'currency'),
    orderId: requiredOrderId(body),
    methodId: requiredInteger(body, 'methodId'),
    statement: requiredText(body, 'statement'),
  }
  const sign = requiredText(body, 'sign')

  if (
    Object.values(notification).some((value) => value === null) ||
    sign === null
  ) {
    throw rejected()
  }

  if (!signatureMatches(notification, p24.crcKey, sign)) {
    throw rejected()
  }

  if (
    notification.merchantId !== p24.merchantId ||
    notification.posId !== p24.posId ||
    !SESSION_ID.test(notification.sessionId)
  ) {
    throw rejected()
  }

  return {
    merchantId: notification.merchantId,
    posId: notification.posId,
    sessionId: notification.sessionId,
    amount: notification.amount,
    originAmount: notification.originAmount,
    currency: notification.currency,
    orderId: notification.orderId,
    methodId: notification.methodId,
  }
}

function signatureMatches(notification, crcKey, sign) {
  try {
    return verifyTransactionNotification({
      ...notification,
      crc: crcKey,
      sign,
    })
  } catch (error) {
    if (error instanceof P24DataError || error instanceof P24ResponseError) {
      return false
    }

    throw error
  }
}

function hasNotificationConfig(p24) {
  return (
    typeof p24?.merchantId === 'string' &&
    typeof p24?.posId === 'string' &&
    typeof p24?.crcKey === 'string' &&
    p24.merchantId.length > 0 &&
    p24.posId.length > 0 &&
    p24.crcKey.length > 0
  )
}

function parsedObject(text) {
  let body

  try {
    body = parseJsonWithIntegerStrings(text)
  } catch (error) {
    if (error instanceof P24ResponseError) {
      throw rejected()
    }

    throw error
  }

  if (
    body === null ||
    typeof body !== 'object' ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw rejected()
  }

  return body
}

function requiredInteger(body, field) {
  if (!Object.hasOwn(body, field)) {
    return null
  }

  const digits = jsonIntegerDigits(body[field])

  if (digits === null) {
    return null
  }

  try {
    return decimalInteger(digits, field)
  } catch (error) {
    if (error instanceof P24DataError) {
      return null
    }

    throw error
  }
}

function requiredOrderId(body) {
  const digits = requiredInteger(body, 'orderId')

  if (digits === null || digits === '0' || BigInt(digits) > INT64_MAX) {
    return null
  }

  return digits
}

function requiredText(body, field) {
  if (!Object.hasOwn(body, field) || typeof body[field] !== 'string') {
    return null
  }

  return body[field]
}

function rejected() {
  return new HttpError({
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    logMessage: 'p24.notification_rejected',
  })
}
