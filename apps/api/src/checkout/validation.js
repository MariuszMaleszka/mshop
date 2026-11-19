import { createHash } from 'node:crypto'
import { z } from 'zod'

export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/

const requiredText = (max) => z.string().trim().min(1).max(max)
const optionalText = (max) => requiredText(max).optional()

export const checkoutBodySchema = z
  .object({
    email: z.email().max(320),
    customerType: z.enum(['individual', 'company']),
    paymentMethod: z.enum(['online', 'cash']),
    billing: z
      .object({
        firstName: optionalText(100),
        lastName: optionalText(100),
        companyName: optionalText(200),
        nip: z
          .string()
          .regex(/^[0-9]{10}$/)
          .optional(),
        phone: optionalText(32),
        recipient: optionalText(200),
        street: requiredText(200),
        buildingNumber: requiredText(20),
        apartmentNumber: optionalText(20),
        postalCode: z.string().regex(/^[0-9]{2}-[0-9]{3}$/),
        city: requiredText(100),
        countryCode: z.string().regex(/^[A-Z]{2}$/),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.customerType === 'individual') {
      requireBilling(context, value.billing.firstName, 'firstName')
      requireBilling(context, value.billing.lastName, 'lastName')
    }

    if (value.customerType === 'company') {
      requireBilling(context, value.billing.companyName, 'companyName')
      requireBilling(context, value.billing.nip, 'nip')
    }
  })

export function checkoutRequestHash(body) {
  const billing = {}

  for (const key of Object.keys(body.billing).sort()) {
    billing[key] = body.billing[key]
  }

  const canonical = JSON.stringify({
    billing,
    customerType: body.customerType,
    email: body.email,
    paymentMethod: body.paymentMethod,
  })

  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function requireBilling(context, value, field) {
  if (typeof value === 'string' && value.trim() !== '') {
    return
  }

  context.addIssue({
    code: 'custom',
    path: ['billing', field],
    message: 'Required',
  })
}
