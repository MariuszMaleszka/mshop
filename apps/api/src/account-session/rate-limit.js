import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

const WINDOW_SQL = `date_bin(interval '15 minutes', now(), timestamptz 'epoch')`
const SESSION_ID_MAX_LENGTH = 512

export const AUTH_RATE_LIMITS = {
  login: 30,
  login_pair: 10,
  csrf: 60,
  refresh: 30,
}

export class AuthRateLimitError extends Error {
  constructor(code) {
    super('Auth rate limit failed')
    this.name = 'AuthRateLimitError'
    this.code = code
  }
}

export function normalizeLoginEmail(value) {
  if (typeof value !== 'string') {
    throw new AuthRateLimitError('invalid_subject')
  }

  const email = value.trim().normalize('NFC').toLowerCase()
  const at = email.indexOf('@')

  if (
    at <= 0 ||
    at !== email.lastIndexOf('@') ||
    at === email.length - 1 ||
    /\s/.test(email) ||
    email.includes('\u0000')
  ) {
    throw new AuthRateLimitError('invalid_subject')
  }

  return email
}

export function authRateLimitBucket(key, parts) {
  assertKey(key)

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new AuthRateLimitError('invalid_subject')
  }

  return createHmac('sha256', key).update(encodeParts(parts)).digest('hex')
}

export function consumeLoginRateLimit(database, { key, ip }) {
  return consume(database, key, 'login', [canonicalIp(ip)])
}

export function consumeLoginPairRateLimit(database, { key, ip, email }) {
  return consume(database, key, 'login_pair', [
    canonicalIp(ip),
    normalizeLoginEmail(email),
  ])
}

export function consumeCsrfRateLimit(database, { key, ip }) {
  return consume(database, key, 'csrf', [canonicalIp(ip)])
}

export function consumeRefreshRateLimit(database, { key, sessionId }) {
  return consume(database, key, 'refresh', [readSessionId(sessionId)])
}

export async function clearLoginPairRateLimit(database, { key, ip, email }) {
  const bucket = authRateLimitBucket(key, [
    'login_pair',
    canonicalIp(ip),
    normalizeLoginEmail(email),
  ])

  try {
    await database.query(
      `
        delete from public.auth_attempt_counters
        where bucket_hash = $1
          and purpose = 'login_pair'
          and window_start = ${WINDOW_SQL}
      `,
      [bucket],
    )
  } catch (error) {
    throw unavailable(error)
  }
}

export async function deleteClosedAuthAttemptWindows(database) {
  try {
    const result = await database.query(
      `
        delete from public.auth_attempt_counters
        where window_start + interval '15 minutes' <= now()
      `,
    )
    return result.rowCount
  } catch (error) {
    throw unavailable(error)
  }
}

async function consume(database, key, purpose, fields) {
  const limit = AUTH_RATE_LIMITS[purpose]
  const bucket = authRateLimitBucket(key, [purpose, ...fields])

  let updated

  try {
    updated = await database.query(
      `
        insert into public.auth_attempt_counters (
          bucket_hash,
          purpose,
          window_start,
          count
        )
        select $1, $2, ${WINDOW_SQL}, 1
        on conflict (bucket_hash, purpose, window_start)
        do update
          set count = auth_attempt_counters.count + 1
          where auth_attempt_counters.count < $3
        returning count, window_start
      `,
      [bucket, purpose, limit],
    )
  } catch (error) {
    throw unavailable(error)
  }

  if (updated.rows.length === 1) {
    return decision(true, updated.rows[0], limit, purpose)
  }

  let current

  try {
    current = await database.query(
      `
        select count, window_start
        from public.auth_attempt_counters
        where bucket_hash = $1
          and purpose = $2
          and window_start = ${WINDOW_SQL}
      `,
      [bucket, purpose],
    )
  } catch (error) {
    throw unavailable(error)
  }

  if (current.rows.length !== 1) {
    throw new AuthRateLimitError('unavailable')
  }

  return decision(false, current.rows[0], limit, purpose)
}

function decision(allowed, row, limit, purpose) {
  const count = Number(row.count)

  if (
    !Number.isInteger(count) ||
    !(row.window_start instanceof Date) ||
    (allowed && (count < 1 || count > limit)) ||
    (!allowed && count < limit)
  ) {
    throw new AuthRateLimitError('unavailable')
  }

  return {
    allowed,
    count,
    limit,
    purpose,
    windowStart: row.window_start,
  }
}

function unavailable(error) {
  if (error instanceof AuthRateLimitError) {
    return error
  }

  return new AuthRateLimitError('unavailable')
}

function assertKey(key) {
  if (key == null) {
    throw new AuthRateLimitError('missing_key')
  }

  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new AuthRateLimitError('invalid_key')
  }
}

function canonicalIp(value) {
  if (typeof value !== 'string') {
    throw new AuthRateLimitError('invalid_subject')
  }

  const trimmed = value.trim()
  const kind = isIP(trimmed)

  if (kind === 4) {
    return canonicalIpv4(trimmed)
  }

  if (kind === 6) {
    return canonicalIpv6(trimmed)
  }

  throw new AuthRateLimitError('invalid_subject')
}

function canonicalIpv4(value) {
  const parts = value.split('.')

  if (parts.some((part) => !/^[0-9]{1,3}$/.test(part))) {
    throw new AuthRateLimitError('invalid_subject')
  }

  return parts.map((part) => String(Number(part))).join('.')
}

function canonicalIpv6(value) {
  const lower = value.toLowerCase()

  if (lower.includes('%')) {
    throw new AuthRateLimitError('invalid_subject')
  }

  const groups = expandIpv6(lower)

  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return [
      groups[6] >> 8,
      groups[6] & 255,
      groups[7] >> 8,
      groups[7] & 255,
    ].join('.')
  }

  return compressIpv6(groups)
}

function expandIpv6(value) {
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  const hasIpv4 = tail.includes('.')
  const head = hasIpv4 ? value.slice(0, lastColon) : value
  const halves = head.split('::')

  if (halves.length > 2) {
    throw new AuthRateLimitError('invalid_subject')
  }

  const parse = (text) => {
    if (text === '') {
      return []
    }

    return text.split(':').map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        throw new AuthRateLimitError('invalid_subject')
      }

      return Number.parseInt(part, 16)
    })
  }

  const left = parse(halves[0])
  const right = halves.length === 2 ? parse(halves[1]) : []
  const mapped = hasIpv4 ? ipv4Groups(tail) : []
  const present = left.length + right.length + mapped.length

  if (halves.length === 1) {
    if (present !== 8) {
      throw new AuthRateLimitError('invalid_subject')
    }

    return [...left, ...mapped]
  }

  if (present >= 8) {
    throw new AuthRateLimitError('invalid_subject')
  }

  return [...left, ...new Array(8 - present).fill(0), ...right, ...mapped]
}

function ipv4Groups(value) {
  const numbers = canonicalIpv4(value).split('.').map(Number)
  return [(numbers[0] << 8) | numbers[1], (numbers[2] << 8) | numbers[3]]
}

function compressIpv6(groups) {
  let bestStart = -1
  let bestLength = 0
  let runStart = -1

  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      if (runStart < 0) {
        runStart = index
      }
      continue
    }

    if (runStart < 0) {
      continue
    }

    const length = index - runStart

    if (length > bestLength) {
      bestStart = runStart
      bestLength = length
    }

    runStart = -1
  }

  const hex = groups.map((group) => group.toString(16))

  if (bestLength < 2) {
    return hex.join(':')
  }

  const left = hex.slice(0, bestStart).join(':')
  const right = hex.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

function readSessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SESSION_ID_MAX_LENGTH ||
    value.includes('\u0000')
  ) {
    throw new AuthRateLimitError('invalid_subject')
  }

  return value
}

function encodeParts(parts) {
  const buffers = parts.map((part) => {
    if (typeof part !== 'string') {
      throw new AuthRateLimitError('invalid_subject')
    }

    return Buffer.from(part, 'utf8')
  })
  const size = buffers.reduce((sum, part) => sum + 4 + part.length, 0)
  const encoded = Buffer.alloc(size)
  let offset = 0

  for (const part of buffers) {
    encoded.writeUInt32BE(part.length, offset)
    offset += 4
    part.copy(encoded, offset)
    offset += part.length
  }

  return encoded
}
