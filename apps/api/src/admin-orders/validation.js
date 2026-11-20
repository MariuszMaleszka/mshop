import { z } from 'zod'
import { paginationQuerySchema } from '../http/pagination.js'

export const adminOrderParamsSchema = z.object({
  id: z.uuid(),
})

const paymentStatuses = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
]
const fulfillmentStatuses = ['new', 'processing', 'completed', 'cancelled']
const paymentMethods = ['online', 'cash']

export const adminOrderListQuerySchema = paginationQuerySchema.and(
  z.object({
    search: z.preprocess(
      blankToUndefined,
      z.string().min(1).max(80).optional(),
    ),
    paymentStatus: z.preprocess(
      blankToUndefined,
      z.enum(paymentStatuses).optional(),
    ),
    fulfillmentStatus: z.preprocess(
      blankToUndefined,
      z.enum(fulfillmentStatuses).optional(),
    ),
    paymentMethod: z.preprocess(
      blankToUndefined,
      z.enum(paymentMethods).optional(),
    ),
    sortBy: z.enum(['createdAt', 'orderNumber']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
)

function blankToUndefined(value) {
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
