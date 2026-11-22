import { HttpError } from '../http/errors.js'
import {
  authenticateInternalRequest,
  internalCallHttpResult,
} from '../http/internal-call.js'
import { consumeCsrfRateLimit } from './rate-limit.js'
import {
  createLoginChallenge,
  createLoginChallengeValue,
} from './repository.js'

export const LOGIN_CHALLENGE_PATH = '/api/v1/internal/login-challenges'

export async function issueLoginChallenge(request, dependencies) {
  const authenticate = dependencies.authenticate ?? authenticateInternalRequest
  const consumeRateLimit = dependencies.consumeRateLimit ?? consumeCsrfRateLimit
  const createValue = dependencies.createValue ?? createLoginChallengeValue
  const storeChallenge = dependencies.storeChallenge ?? createLoginChallenge
  const auth = authenticate(request, {
    secret: dependencies.bffInternalSecret,
    trustedPeers: dependencies.bffTrustedPeers,
  })

  if (!auth.ok) {
    return internalCallHttpResult(auth)
  }

  let decision

  try {
    decision = await consumeRateLimit(dependencies.database, {
      key: dependencies.rateLimitHmacKey,
      ip: auth.clientIp,
    })
  } catch {
    throw unavailable()
  }

  if (!decision?.allowed) {
    throw new HttpError({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Request rejected',
    })
  }

  const challengeId = createValue()
  const csrfSecret = createValue()

  try {
    await storeChallenge(dependencies.database, { challengeId, csrfSecret })
  } catch {
    throw unavailable()
  }

  return {
    status: 200,
    body: { challengeId, csrfSecret },
  }
}

function unavailable() {
  return new HttpError({
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service unavailable',
  })
}
