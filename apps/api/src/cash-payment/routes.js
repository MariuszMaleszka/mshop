import { z } from 'zod'
import { requireAdmin } from '../auth/require-admin.js'
import { requireAuth } from '../auth/require-auth.js'
import { IDEMPOTENCY_KEY_PATTERN } from '../checkout/validation.js'
import { HttpError } from '../http/errors.js'
import { validateRequest } from '../http/validate-request.js'
import { CashCancelRejection, cancelCashOrder } from './cancel.js'
import { CashReceiptRejection, confirmCashReceipt } from './confirm.js'

const paramsSchema = z.object({
  id: z.uuid(),
})

export function registerCashReceiptRoutes(app, { database } = {}) {
  app.post(
    '/api/v1/admin/orders/:id/mark-paid',
    requireIdempotencyKey,
    validateRequest({ params: paramsSchema }),
    requireAuth(app.locals.accessTokens),
    requireAdmin(database),
    async (req, res) => {
      try {
        const outcome = await database.withTransaction((tx) =>
          confirmCashReceipt(tx, {
            adminUserId: req.auth.userId,
            orderId: req.validated.params.id,
            idempotencyKey: req.cashReceiptIdempotencyKey,
          }),
        )
        res.status(outcome.status).json(outcome.body)
      } catch (error) {
        if (error instanceof CashReceiptRejection) {
          throw new HttpError({
            status: error.status,
            code: error.code,
            message: error.message,
            logMessage: `cash_receipt.${error.code.toLowerCase()}`,
          })
        }

        if (error instanceof HttpError) {
          throw error
        }

        throw new HttpError({
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
          logMessage: 'cash_receipt.query_failed',
        })
      }
    },
  )

  app.post(
    '/api/v1/admin/orders/:id/cancel',
    requireIdempotencyKey,
    validateRequest({ params: paramsSchema }),
    requireAuth(app.locals.accessTokens),
    requireAdmin(database),
    async (req, res) => {
      try {
        const outcome = await database.withTransaction((tx) =>
          cancelCashOrder(tx, {
            adminUserId: req.auth.userId,
            orderId: req.validated.params.id,
            idempotencyKey: req.cashReceiptIdempotencyKey,
          }),
        )
        res.status(outcome.status).json(outcome.body)
      } catch (error) {
        if (error instanceof CashCancelRejection) {
          throw new HttpError({
            status: error.status,
            code: error.code,
            message: error.message,
            logMessage: `cash_cancel.${error.code.toLowerCase()}`,
          })
        }

        if (error instanceof HttpError) {
          throw error
        }

        throw new HttpError({
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
          logMessage: 'cash_cancel.query_failed',
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
      logMessage: 'cash_receipt.idempotency_key',
    })
  }

  req.cashReceiptIdempotencyKey = String(values[0])
  next()
}

function headerValues(req, name) {
  const rawHeaders = req.rawHeaders

  if (!Array.isArray(rawHeaders)) {
    const value = req.get(name)
    return value === undefined ? [] : [value]
  }

  const values = []

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === name) {
      values.push(rawHeaders[index + 1])
    }
  }

  return values
}
