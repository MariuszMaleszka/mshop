import { HttpError } from '../http/errors.js'
import { validateRequest } from '../http/validate-request.js'
import {
  GUEST_SESSION_COOKIE,
  hashGuestSessionId,
  readGuestSessionId,
} from '../session/guest-session.js'
import {
  addGuestCartItem,
  CartAmountError,
  deleteGuestCartItem,
  findGuestCart,
  updateGuestCartItem,
} from './repository.js'
import {
  addCartItemSchema,
  cartItemParamsSchema,
  updateCartItemSchema,
} from './validation.js'

export function registerCartRoutes(app, { database } = {}) {
  app.get('/api/v1/cart', requireGuestCart, async (req, res) => {
    const data = await readCart(() => findGuestCart(database, req.guestCartKey))
    res.status(200).json({ data, meta: {} })
  })

  app.post(
    '/api/v1/cart/items',
    requireGuestCart,
    validateRequest({ body: addCartItemSchema }),
    async (req, res) => {
      const { productId, quantity } = req.validated.body

      await readCart(async () => {
        const result = await addGuestCartItem(database, req.guestCartKey, {
          productId,
          quantity,
        })
        assertAdded(result)
      })
      const data = await readCart(() =>
        findGuestCart(database, req.guestCartKey),
      )
      res.status(200).json({ data, meta: {} })
    },
  )

  app.patch(
    '/api/v1/cart/items/:id',
    requireGuestCart,
    validateRequest({
      params: cartItemParamsSchema,
      body: updateCartItemSchema,
    }),
    async (req, res) => {
      const updated = await readCart(() =>
        updateGuestCartItem(database, req.guestCartKey, {
          itemId: req.validated.params.id,
          quantity: req.validated.body.quantity,
        }),
      )

      if (!updated) {
        throw notFound()
      }

      const data = await readCart(() =>
        findGuestCart(database, req.guestCartKey),
      )
      res.status(200).json({ data, meta: {} })
    },
  )

  app.delete(
    '/api/v1/cart/items/:id',
    requireGuestCart,
    validateRequest({ params: cartItemParamsSchema }),
    async (req, res) => {
      const deleted = await readCart(() =>
        deleteGuestCartItem(
          database,
          req.guestCartKey,
          req.validated.params.id,
        ),
      )

      if (!deleted) {
        throw notFound()
      }

      const data = await readCart(() =>
        findGuestCart(database, req.guestCartKey),
      )
      res.status(200).json({ data, meta: {} })
    },
  )
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
