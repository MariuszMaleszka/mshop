import { z } from 'zod'

const quantitySchema = z.number().int().positive().max(2147483647)

export const cartItemParamsSchema = z.object({
  id: z.uuid(),
})

export const addCartItemSchema = z.object({
  productId: z.uuid(),
  quantity: quantitySchema,
})

export const updateCartItemSchema = z.object({
  quantity: quantitySchema,
})
