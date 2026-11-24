import { decodeJwt } from 'jose'

export function readAccessTokenExpiry(accessToken, nowMs = Date.now()) {
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { status: 'invalid' }
  }

  let payload

  try {
    payload = decodeJwt(accessToken)
  } catch {
    return { status: 'invalid' }
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    return { status: 'invalid' }
  }

  const nowSec = Math.floor(nowMs / 1000)

  if (payload.exp > nowSec) {
    return { status: 'valid', exp: payload.exp }
  }

  return { status: 'expired', exp: payload.exp }
}
