import { z } from 'zod'
import { paginationQuerySchema } from '../http/pagination.js'

export const catalogIdParamsSchema = z.object({
  id: z.uuid(),
})

export const productListQuerySchema = paginationQuerySchema.and(
  z.object({
    category_id: z.uuid().optional(),
    product_type: z.enum(['physical', 'digital', 'service']).optional(),
  }),
)
