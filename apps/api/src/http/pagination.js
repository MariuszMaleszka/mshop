import { z } from 'zod'

const pageSchema = z.coerce.number().int().positive().default(1)
const limitSchema = z.coerce.number().int().positive().max(100).default(20)

export const paginationQuerySchema = z
  .object({
    page: pageSchema,
    limit: limitSchema,
  })
  .transform((value) => ({
    page: value.page,
    limit: value.limit,
    offset: (value.page - 1) * value.limit,
  }))
  .refine((value) => Number.isSafeInteger(value.offset), {
    path: ['page'],
    message: 'Invalid page',
  })

export function paginationOffset(page, limit) {
  if (!Number.isInteger(page) || page < 1) {
    throw new TypeError('page must be a positive integer')
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be an integer from 1 to 100')
  }

  const offset = (page - 1) * limit

  if (!Number.isSafeInteger(offset)) {
    throw new TypeError('pagination offset is out of range')
  }

  return offset
}
