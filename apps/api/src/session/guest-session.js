import { createHash, randomBytes } from 'node:crypto'

export const GUEST_SESSION_COOKIE = 'shop_guest_session'
export const GUEST_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const GUEST_SESSION_PATTERN = /^[0-9a-f]{64}$/

export function createGuestSessionId() {
  return randomBytes(32).toString('hex')
}

export function hashGuestSessionId(sessionId) {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex')
}

export function readGuestSessionId(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return null
  }

  const parts = cookieHeader.split(';')

  for (const part of parts) {
    const separator = part.indexOf('=')

    if (separator === -1) {
      continue
    }

    const name = part.slice(0, separator).trim()

    if (name !== GUEST_SESSION_COOKIE) {
      continue
    }

    const rawValue = part.slice(separator + 1).trim()
    let value

    try {
      value = decodeURIComponent(rawValue)
    } catch {
      return null
    }

    return GUEST_SESSION_PATTERN.test(value) ? value : null
  }

  return null
}

export function guestSessionCookieOptions(nodeEnv) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: nodeEnv === 'production',
    path: '/',
    maxAge: GUEST_SESSION_MAX_AGE_MS,
  }
}
