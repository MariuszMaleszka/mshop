import { canonicalIpAddress } from '../http/ip-address.js'
import {
  consumeLoginPairRateLimit,
  consumeLoginRateLimit,
  normalizeLoginEmail,
} from './rate-limit.js'
import {
  consumeLoginChallenge,
  isLoginChallengeValue,
  sha256Hex,
} from './repository.js'

export class LoginAttemptError extends Error {
  constructor(code) {
    super('Login attempt rejected')
    this.name = 'LoginAttemptError'
    this.code = code
  }
}

export async function prepareLoginAttempt(
  { database, clientIp, challengeId, csrfSecret, email, key } = {},
  dependencies = {},
) {
  if (
    !isLoginChallengeValue(challengeId) ||
    !isLoginChallengeValue(csrfSecret)
  ) {
    throw new LoginAttemptError('rejected')
  }

  if (!database || typeof database.query !== 'function') {
    throw new LoginAttemptError('unavailable')
  }

  if (!isTrustedClientIp(clientIp) || !isLoginEmail(email)) {
    throw new LoginAttemptError('rejected')
  }

  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new LoginAttemptError('unavailable')
  }

  const consumeChallenge =
    dependencies.consumeChallenge ?? consumeLoginChallenge
  const consumeIpLimit = dependencies.consumeIpLimit ?? consumeLoginRateLimit
  const consumePairLimit =
    dependencies.consumePairLimit ?? consumeLoginPairRateLimit
  const consumed = await readConsumed(consumeChallenge, database, {
    idHash: sha256Hex(challengeId),
    csrfTokenHash: sha256Hex(csrfSecret),
  })

  if (consumed !== 1) {
    throw new LoginAttemptError(
      consumed === 0 ? 'invalid_challenge' : 'unavailable',
    )
  }

  const ipLimit = await readLimit(() =>
    consumeIpLimit(database, { key, ip: clientIp }),
  )

  if (!ipLimit.allowed) {
    throw new LoginAttemptError('rate_limited')
  }

  const pairLimit = await readLimit(() =>
    consumePairLimit(database, { key, ip: clientIp, email }),
  )

  if (!pairLimit.allowed) {
    throw new LoginAttemptError('rate_limited')
  }

  return { ok: true }
}

function isTrustedClientIp(value) {
  return typeof value === 'string' && canonicalIpAddress(value) === value
}

function isLoginEmail(value) {
  try {
    normalizeLoginEmail(value)
    return true
  } catch {
    return false
  }
}

async function readConsumed(consumeChallenge, database, hashes) {
  try {
    return await consumeChallenge(database, hashes)
  } catch {
    throw new LoginAttemptError('unavailable')
  }
}

async function readLimit(consume) {
  let decision

  try {
    decision = await consume()
  } catch {
    throw new LoginAttemptError('unavailable')
  }

  if (typeof decision?.allowed !== 'boolean') {
    throw new LoginAttemptError('unavailable')
  }

  return decision
}
