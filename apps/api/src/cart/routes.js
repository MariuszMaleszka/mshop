import { requireAuth } from '../auth/require-auth.js'
import { HttpError } from '../http/errors.js'
import { validateRequest } from '../http/validate-request.js'
import {
  GUEST_SESSION_COOKIE,
  hashGuestSessionId,
  readGuestSessionId,
} from '../session/guest-session.js'
import {
  addAccountCartItem,
  addGuestCartItem,
  CartAmountError,
  deleteAccountCartItem,
  deleteGuestCartItem,
  findAccountCart,
  findGuestCart,
  updateAccountCartItem,
  updateGuestCartItem,
} from './repository.js'
import {
  addCartItemSchema,
  cartItemParamsSchema,
  updateCartItemSchema,
} from './validation.js'

export function registerCartRoutes(app, { database } = {}) {
  app.get('/api/v1/cart', selectCartAccess, async (req, res) => {
    const data = await readCart(() => findCart(database, req))
    res.status(200).json({ data, meta: {} })
  })

  app.post(
    '/api/v1/cart/items',
    selectCartAccess,
    validateRequest({ body: addCartItemSchema }),
    async (req, res) => {
      const { productId, quantity } = req.validated.body

      await readCart(async () => {
        const result = await addItem(database, req, productId, quantity)
        assertAdded(result)
      })
      const data = await readCart(() => findCart(database, req))
      res.status(200).json({ data, meta: {} })
    },
  )

  app.patch(
    '/api/v1/cart/items/:id',
    selectCartAccess,
    validateRequest({
      params: cartItemParamsSchema,
      body: updateCartItemSchema,
    }),
    async (req, res) => {
      const updated = await readCart(() =>
        updateItem(
          database,
          req,
          req.validated.params.id,
          req.validated.body.quantity,
        ),
      )

      if (!updated) {
        throw notFound()
      }

      const data = await readCart(() => findCart(database, req))
      res.status(200).json({ data, meta: {} })
    },
  )

  app.delete(
    '/api/v1/cart/items/:id',
    selectCartAccess,
    validateRequest({ params: cartItemParamsSchema }),
    async (req, res) => {
      const deleted = await readCart(() =>
        deleteItem(database, req, req.validated.params.id),
      )

      if (!deleted) {
        throw notFound()
      }

      const data = await readCart(() => findCart(database, req))
      res.status(200).json({ data, meta: {} })
    },
  )
}

function selectCartAccess(req, res, next) {
  if (hasAuthorizationHeader(req)) {
    const authenticate = requireAuth(req.app.locals.accessTokens)
    return authenticate(req, res, next)
  }

  requireGuestCart(req, res, next)
}

function hasAuthorizationHeader(req) {
  const rawHeaders = req.rawHeaders

  if (!Array.isArray(rawHeaders)) {
    return req.get('authorization') !== undefined
  }

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === 'authorization') {
      return true
    }
  }

  return false
}

function findCart(database, req) {
  if (hasAuthorizationHeader(req)) {
    return findAccountCart(database, req.auth.userId)
  }

  return findGuestCart(database, req.guestCartKey)
}

function addItem(database, req, productId, quantity) {
  if (hasAuthorizationHeader(req)) {
    return addAccountCartItem(database, req.auth.userId, {
      productId,
      quantity,
    })
  }

  return addGuestCartItem(database, req.guestCartKey, { productId, quantity })
}

function updateItem(database, req, itemId, quantity) {
  if (hasAuthorizationHeader(req)) {
    return updateAccountCartItem(database, req.auth.userId, {
      itemId,
      quantity,
    })
  }

  return updateGuestCartItem(database, req.guestCartKey, { itemId, quantity })
}

function deleteItem(database, req, itemId) {
  if (hasAuthorizationHeader(req)) {
    return deleteAccountCartItem(database, req.auth.userId, itemId)
  }

  return deleteGuestCartItem(database, req.guestCartKey, itemId)
}

function requireGuestCart(req, _res, next) {
  const header = req.get('cookie')
  const sessionId = readGuestSessionId(header)

  if (!sessionId) {
    throw new HttpError({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      logMessage: cookieNamePresent(header)
        ? 'cart.invalid_session'
        : 'cart.missing_session',
    })
  }

  req.guestCartKey = hashGuestSessionId(sessionId)
  next()
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

function assertAdded(result) {
  if (result.outcome === 'missing' || result.outcome === 'inactive') {
    throw notFound()
  }

  if (result.outcome === 'overflow') {
    throw quantityOverflow()
  }

  if (result.outcome === 'currency') {
    throw new HttpError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: [
        {
          location: 'product',
          path: 'currency',
          code: 'invalid',
          message: 'Only PLN products can be added',
        },
      ],
      logMessage: 'cart.currency',
    })
  }

  if (result.outcome !== 'ready' || result.written !== 1 || result.carts < 1) {
    throw new TypeError('Invalid cart write result')
  }
}

async function readCart(read) {
  try {
    return await read()
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }

    if (error instanceof CartAmountError) {
      throw amountOverflow()
    }

    throw new HttpError({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
      logMessage: 'cart.query_failed',
    })
  }
}

function quantityOverflow() {
  return new HttpError({
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Invalid request data',
    details: [
      {
        location: 'body',
        path: 'quantity',
        code: 'too_big',
        message: 'Quantity exceeds the allowed maximum',
      },
    ],
    logMessage: 'cart.quantity',
  })
}

function amountOverflow() {
  return new HttpError({
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Invalid request data',
    details: [
      {
        location: 'cart',
        path: 'total_amount',
        code: 'too_big',
        message: 'Cart amount exceeds the supported range',
      },
    ],
    logMessage: 'cart.amount',
  })
}

function notFound() {
  return new HttpError({
    status: 404,
    code: 'NOT_FOUND',
    message: 'Resource not found',
  })
}
