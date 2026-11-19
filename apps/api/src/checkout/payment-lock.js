export const PAYMENT_ADVISORY_LOCK_NAMESPACE = 71003

const PAYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function paymentAdvisoryLockKey(paymentId) {
  if (typeof paymentId !== 'string' || !PAYMENT_ID.test(paymentId)) {
    throw new TypeError('Invalid payment id')
  }

  return Buffer.from(paymentId.slice(0, 8), 'hex').readInt32BE(0)
}
