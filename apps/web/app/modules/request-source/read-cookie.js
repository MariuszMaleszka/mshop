const COOKIE_NAME = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/
const CHALLENGE_ID_BYTES = 32

export function readCookieValue(cookieHeader, name) {
  if (typeof name !== 'string' || !COOKIE_NAME.test(name)) {
    return { status: 'rejected' }
  }

  if (cookieHeader == null) {
    return { status: 'absent' }
  }

  if (typeof cookieHeader !== 'string') {
    return { status: 'rejected' }
  }

  if (cookieHeader.trim() === '') {
    return { status: 'absent' }
  }

  const values = []

  for (const part of cookieHeader.split(';')) {
    if (part.trim() === '') {
      continue
    }

    const separator = part.indexOf('=')

    if (separator <= 0) {
      return { status: 'rejected' }
    }

    const cookieName = part.slice(0, separator).trim()

    if (!COOKIE_NAME.test(cookieName)) {
      return { status: 'rejected' }
    }

    if (cookieName !== name) {
      continue
    }

    const rawValue = part.slice(separator + 1)

    if (rawValue === '' || rawValue !== rawValue.trim()) {
      return { status: 'rejected' }
    }

    values.push(rawValue)
  }

  if (values.length === 0) {
    return { status: 'absent' }
  }

  if (values.length !== 1) {
    return { status: 'rejected' }
  }

  let decoded

  try {
    decoded = decodeURIComponent(values[0])
  } catch {
    return { status: 'rejected' }
  }

  if (!isChallengeId(decoded)) {
    return { status: 'rejected' }
  }

  return { status: 'present', value: decoded }
}

function isChallengeId(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false
  }

  const bytes = Buffer.from(value, 'base64url')
  return (
    bytes.length === CHALLENGE_ID_BYTES && bytes.toString('base64url') === value
  )
}
