import { timingSafeEqual } from 'node:crypto'
import { canonicalIpAddress } from './ip-address.js'

export const INTERNAL_CLIENT_IP_HEADER = 'x-mshop-client-ip'
export const INTERNAL_SECRET_HEADER = 'x-mshop-internal-secret'

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/

export function authenticateInternalCall({
  remoteAddress,
  secretHeader,
  clientIpHeader,
  secret,
  trustedPeers,
}) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) {
    return denied('missing_config')
  }

  if (!Array.isArray(trustedPeers)) {
    return denied('missing_config')
  }

  const peer = canonicalIpAddress(remoteAddress)

  if (!peer || !trustedPeers.includes(peer)) {
    return denied('untrusted_peer')
  }

  if (!secretMatches(secretHeader, secret)) {
    return denied('invalid_secret')
  }

  if (clientIpHeader == null || clientIpHeader === '') {
    return denied('missing_client_ip')
  }

  if (
    typeof clientIpHeader !== 'string' ||
    canonicalIpAddress(clientIpHeader) !== clientIpHeader
  ) {
    return denied('invalid_client_ip')
  }

  return { ok: true, clientIp: clientIpHeader }
}

export function authenticateInternalRequest(request, options) {
  return authenticateInternalCall({
    remoteAddress: request?.socket?.remoteAddress,
    secretHeader: headerText(request, INTERNAL_SECRET_HEADER),
    clientIpHeader: headerText(request, INTERNAL_CLIENT_IP_HEADER),
    secret: options?.secret,
    trustedPeers: options?.trustedPeers,
  })
}

export function internalCallHttpResult(result) {
  if (result?.ok === true) {
    return { status: 200, body: { clientIp: result.clientIp } }
  }

  return { status: 403, body: { code: 'forbidden' } }
}

function denied(reason) {
  return { ok: false, reason }
}

function headerText(request, name) {
  const value = request?.headers?.[name]

  return typeof value === 'string' ? value : undefined
}

function secretMatches(presented, expected) {
  const decoded =
    typeof presented === 'string' && KEY_PATTERN.test(presented)
      ? Buffer.from(presented, 'base64')
      : null
  const canonical = Boolean(
    decoded &&
    decoded.length === 32 &&
    decoded.toString('base64') === presented,
  )
  const actual = canonical ? decoded : Buffer.alloc(32)

  return canonical && timingSafeEqual(actual, expected)
}
