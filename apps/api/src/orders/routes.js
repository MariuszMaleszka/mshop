import { z } from 'zod'
import { requireAuth } from '../auth/require-auth.js'
import { HttpError } from '../http/errors.js'
import { validateRequest } from '../http/validate-request.js'
import {
  GUEST_SESSION_COOKIE,
  hashGuestSessionId,
  readGuestSessionId,
} from '../session/guest-session.js'
import { findOwnedOrder } from './repository.js'

const paramsSchema = z.object({
  id: z.uuid(),
})

export function registerOrderRoutes(app, { database } = {}) {
  app.get(
    '/api/v1/orders/:id',
    validateRequest({ params: paramsSchema }),
    selectOrderAccess,
    async (req, res) => {
      const order = await readOrder(() =>
        findOwnedOrder(database, {
          orderId: req.validated.params.id,
          userId: accountUserId(req),
          sessionId: guestSessionId(req),
        }),
      )

      if (!order) {
        throw notFound()
      }

      res.status(200).json({ data: order, meta: {} })
    },
  )
}

function accountUserId(req) {
  return authorizationCount(req) === 1 ? req.auth.userId : null
}

function guestSessionId(req) {
  return authorizationCount(req) === 1 ? null : req.guestCartKey
}

function selectOrderAccess(req, res, next) {
  const authorizations = authorizationValues(req)

  if (authorizations.length > 1) {
    throw new HttpError({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      logMessage: 'orders.duplicate_authorization',
    })
  }

  if (authorizations.length === 1) {
    const authenticate = requireAuth(req.app.locals.accessTokens)
    return authenticate(req, res, next)
  }

  requireGuestOrder(req, res, next)
}

function requireGuestOrder(req, _res, next) {
  const header = req.get('cookie')
  const sessionId = readGuestSessionId(header)

  if (!sessionId) {
    throw new HttpError({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      logMessage: cookieNamePresent(header)
        ? 'orders.invalid_session'
        : 'orders.missing_session',
    })
  }

  req.guestCartKey = hashGuestSessionId(sessionId)
  next()
}

function authorizationCount(req) {
  return authorizationValues(req).length
}

function authorizationValues(req) {
  const rawHeaders = req.rawHeaders

  if (!Array.isArray(rawHeaders)) {
    const value = req.get('authorization')
    return value === undefined ? [] : [value]
  }

  const values = []

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === 'authorization') {
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

async function readOrder(read) {
  try {
    return await read()
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }

    throw new HttpError({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
      logMessage: 'orders.query_failed',
    })
  }
}

function notFound() {
  return new HttpError({
    status: 404,
    code: 'NOT_FOUND',
    message: 'Resource not found',
  })
}
