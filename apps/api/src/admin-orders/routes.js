import { requireAdmin } from '../auth/require-admin.js'
import { requireAuth } from '../auth/require-auth.js'
import { HttpError } from '../http/errors.js'
import { validateRequest } from '../http/validate-request.js'
import { findAdminOrder, listAdminOrders } from './repository.js'
import {
  adminOrderListQuerySchema,
  adminOrderParamsSchema,
} from './validation.js'

export function registerAdminOrderRoutes(app, { database } = {}) {
  app.get(
    '/api/v1/admin/orders',
    requireAuth(app.locals.accessTokens),
    requireAdmin(database),
    validateRequest({ query: adminOrderListQuerySchema }),
    async (req, res) => {
      const { page, limit } = req.validated.query
      const result = await readOrders(() =>
        listAdminOrders(database, req.validated.query),
      )

      res.status(200).json({
        data: result.rows,
        meta: {
          page,
          limit,
          total: result.total,
          totalPages: result.total === 0 ? 0 : Math.ceil(result.total / limit),
        },
      })
    },
  )

  app.get(
    '/api/v1/admin/orders/:id',
    validateRequest({ params: adminOrderParamsSchema }),
    requireAuth(app.locals.accessTokens),
    requireAdmin(database),
    async (req, res) => {
      const order = await readOrders(() =>
        findAdminOrder(database, req.validated.params.id),
      )

      if (!order) {
        throw new HttpError({
          status: 404,
          code: 'NOT_FOUND',
          message: 'Resource not found',
          logMessage: 'admin_orders.not_found',
        })
      }

      res.status(200).json({ data: order, meta: {} })
    },
  )
}

async function readOrders(read) {
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
      logMessage: 'admin_orders.query_failed',
    })
  }
}
