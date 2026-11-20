export function formatGrosze(amount, currency) {
  if (typeof amount !== 'string' || typeof currency !== 'string') {
    return null
  }

  if (!/^-?\d+$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) {
    return null
  }

  const negative = amount.startsWith('-')
  const digits = negative ? amount.slice(1) : amount
  const major = (digits.length > 2 ? digits.slice(0, -2) : '0').replace(
    /^0+(?=\d)/,
    '',
  )
  const minor = digits.slice(-2).padStart(2, '0')

  return `${negative ? '-' : ''}${major || '0'},${minor} ${currency}`
}

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
