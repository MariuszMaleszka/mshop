import { canonicalIpAddress } from './ip-address.js'

export const INTERNAL_CLIENT_IP_HEADER = 'x-mshop-client-ip'
export const INTERNAL_SECRET_HEADER = 'x-mshop-internal-secret'

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/

export function prepareInternalCall({ remoteAddress, secret }) {
  if (typeof secret !== 'string' || !KEY_PATTERN.test(secret)) {
    return { ok: false, reason: 'missing_config' }
  }

  const decoded = Buffer.from(secret, 'base64')

  if (decoded.length !== 32 || decoded.toString('base64') !== secret) {
    return { ok: false, reason: 'missing_config' }
  }

  if (typeof remoteAddress !== 'string' || remoteAddress.length === 0) {
    return { ok: false, reason: 'missing_client_ip' }
  }

  const clientIp = canonicalIpAddress(remoteAddress)

  if (!clientIp) {
    return { ok: false, reason: 'invalid_client_ip' }
  }

  return {
    ok: true,
    clientIp,
    headers: {
      [INTERNAL_CLIENT_IP_HEADER]: clientIp,
      [INTERNAL_SECRET_HEADER]: secret,
    },
  }
}

export function prepareInternalCallFromRequest(request, options) {
  return prepareInternalCall({
    remoteAddress: request?.socket?.remoteAddress,
    secret: options?.secret,
  })
}

export function serverInternalSecret(runtimeConfig) {
  const value = runtimeConfig?.bffInternalSecret

  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    return null
  }

  const decoded = Buffer.from(value, 'base64')

  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    return null
  }

  return value
}

export function browserFacingInternalResult(result) {
  if (result?.ok === true) {
    return { ok: true }
  }

  return { ok: false, code: 'forbidden' }
}
