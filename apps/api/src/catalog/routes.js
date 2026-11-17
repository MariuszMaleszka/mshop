import { paginationQuerySchema } from '../http/pagination.js'
import { HttpError } from '../http/errors.js'
import { validateRequest } from '../http/validate-request.js'
import {
  findActiveCategory,
  findActiveProduct,
  listCategories,
  listProducts,
} from './repository.js'
import { catalogIdParamsSchema, productListQuerySchema } from './validation.js'

export function registerCatalogRoutes(app, { database } = {}) {
  app.get(
    '/api/v1/categories',
    validateRequest({ query: paginationQuerySchema }),
    async (req, res) => {
      const { page, limit, offset } = req.validated.query
      const result = await readCatalog(() =>
        listCategories(database, { limit, offset }),
      )

      res.status(200).json({
        data: result.rows,
        meta: listMeta({ page, limit, total: result.total }),
      })
    },
  )

  app.get(
    '/api/v1/categories/:id',
    validateRequest({ params: catalogIdParamsSchema }),
    async (req, res) => {
      const category = await readCatalog(() =>
        findActiveCategory(database, req.validated.params.id),
      )

      if (!category) {
        throw notFound()
      }

      res.status(200).json({ data: category, meta: {} })
    },
  )

  app.get(
    '/api/v1/products',
    validateRequest({ query: productListQuerySchema }),
    async (req, res) => {
      const {
        page,
        limit,
        offset,
        category_id: categoryId,
        product_type: productType,
      } = req.validated.query
      const result = await readCatalog(() =>
        listProducts(database, { limit, offset, categoryId, productType }),
      )

      res.status(200).json({
        data: result.rows,
        meta: listMeta({ page, limit, total: result.total }),
      })
    },
  )

  app.get(
    '/api/v1/products/:id',
    validateRequest({ params: catalogIdParamsSchema }),
    async (req, res) => {
      const product = await readCatalog(() =>
        findActiveProduct(database, req.validated.params.id),
      )

      if (!product) {
        throw notFound()
      }

      res.status(200).json({ data: product, meta: {} })
    },
  )
}

export function listMeta({ page, limit, total }) {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  }
}

async function readCatalog(read) {
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
      logMessage: 'catalog.query_failed',
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
