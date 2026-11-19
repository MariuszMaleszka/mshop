import { requireAuth } from '../auth/require-auth.js'
import { HttpError } from '../http/errors.js'
import { validateRequest } from '../http/validate-request.js'
import {
  GUEST_SESSION_COOKIE,
  hashGuestSessionId,
  readGuestSessionId,
} from '../session/guest-session.js'
import { CheckoutRejection, placeCashOrder } from './repository.js'
import { IDEMPOTENCY_KEY_PATTERN, checkoutBodySchema } from './validation.js'

export function registerCheckoutRoutes(app, { database } = {}) {
  app.post(
    '/api/v1/checkout',
    requireIdempotencyKey,
    validateRequest({ body: checkoutBodySchema }),
    selectCheckoutAccess,
    async (req, res) => {
      try {
        const outcome = await database.withTransaction((tx) =>
          placeCashOrder(tx, {
            owner: ownerFrom(req),
            idempotencyKey: req.checkoutIdempotencyKey,
            body: req.validated.body,
          }),
        )
        res.status(outcome.status).json(outcome.body)
      } catch (error) {
        if (error instanceof CheckoutRejection) {
          throw new HttpError({
            status: error.status,
            code: error.code,
            message: error.message,
            logMessage: `checkout.${error.code.toLowerCase()}`,
          })
        }

        if (error instanceof HttpError) {
          throw error
        }

        throw new HttpError({
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
          logMessage: 'checkout.query_failed',
        })
      }
    },
  )
}

function requireIdempotencyKey(req, _res, next) {
  const values = headerValues(req, 'idempotency-key')

  if (values.length !== 1 || !IDEMPOTENCY_KEY_PATTERN.test(String(values[0]))) {
    throw new HttpError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: [
        {
          location: 'header',
          path: 'Idempotency-Key',
          code: 'invalid',
          message: 'Idempotency-Key must be 1 to 255 visible ASCII characters',
        },
      ],
      logMessage: 'checkout.idempotency_key',
    })
  }

  req.checkoutIdempotencyKey = String(values[0])
  next()
}

function selectCheckoutAccess(req, res, next) {
  const authorizations = headerValues(req, 'authorization')

  if (authorizations.length > 1) {
    throw new HttpError({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      logMessage: 'checkout.duplicate_authorization',
    })
  }

  if (authorizations.length === 1) {
    const authenticate = requireAuth(req.app.locals.accessTokens)
    return authenticate(req, res, next)
  }

  requireGuestCheckout(req, res, next)
}

function ownerFrom(req) {
  if (headerValues(req, 'authorization').length === 1) {
    return { kind: 'account', key: req.auth.userId }
  }

  return { kind: 'guest', key: req.guestCartKey }
}

function requireGuestCheckout(req, _res, next) {
  const header = req.get('cookie')
  const sessionId = readGuestSessionId(header)

  if (!sessionId) {
    throw new HttpError({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      logMessage: cookieNamePresent(header)
        ? 'checkout.invalid_session'
        : 'checkout.missing_session',
    })
  }

  req.guestCartKey = hashGuestSessionId(sessionId)
  next()
}

function headerValues(req, name) {
  const expected = name.toLowerCase()
  const rawHeaders = req.rawHeaders

  if (!Array.isArray(rawHeaders)) {
    const value = req.get(name)
    return value === undefined ? [] : [value]
  }

  const values = []

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === expected) {
      values.push(rawHeaders[index + 1])
    }
  }

  return values
}

function cookieNamePresent(header) {
  if (typeof header !== 'string') {
    return false
  }

  return header.split(';').some((part) => {
    const separator = part.indexOf('=')

    if (separator === -1) {
      return false
    }

    return part.slice(0, separator).trim() === GUEST_SESSION_COOKIE
  })
}
