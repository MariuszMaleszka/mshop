export function formatAmount(amount, currency) {
  if (!Number.isSafeInteger(amount) || typeof currency !== 'string') {
    return null
  }

  const negative = amount < 0
  const absolute = Math.abs(amount)
  const major = Math.floor(absolute / 100)
  const minor = String(absolute % 100).padStart(2, '0')

  return `${negative ? '-' : ''}${major},${minor} ${currency}`
}
