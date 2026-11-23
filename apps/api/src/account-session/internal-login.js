import { z } from 'zod'
import {
  authenticateInternalRequest,
  internalCallHttpResult,
} from '../http/internal-call.js'
import {
  completeLoginAttempt,
  CompleteLoginError,
} from './complete-login-attempt.js'
import { normalizeLoginEmail } from './rate-limit.js'
import { isLoginChallengeValue } from './repository.js'

export const INTERNAL_LOGIN_PATH = '/api/v1/internal/login'

const SESSION_HASH = /^[0-9a-f]{64}$/

const loginBodySchema = z
  .object({
    challengeId: z.string().refine(isLoginChallengeValue),
    csrfSecret: z.string().refine(isLoginChallengeValue),
    email: z.string().refine(isLoginEmail),
    password: z.string().min(1),
    previousSessionHash: z.string().regex(SESSION_HASH).optional(),
  })
  .strict()

const LOGIN_HTTP = {
  rejected: { status: 400, code: 'invalid_request' },
  invalid_challenge: { status: 403, code: 'invalid_challenge' },
  rate_limited: { status: 429, code: 'rate_limited' },
  invalid_credentials: { status: 401, code: 'invalid_credentials' },
  unavailable: { status: 503, code: 'unavailable' },
  configuration: { status: 503, code: 'unavailable' },
  invalid_response: { status: 503, code: 'unavailable' },
  session_failed: { status: 503, code: 'unavailable' },
}

export async function handleInternalLogin(request, dependencies = {}) {
  const auth = authenticateInternalRequest(request, {
    secret: dependencies.bffInternalSecret,
    trustedPeers: dependencies.bffTrustedPeers,
  })

  if (!auth.ok) {
    return internalCallHttpResult(auth)
  }

  const parsed = loginBodySchema.safeParse(request?.body)

  if (!parsed.success) {
    return failure(400, 'invalid_request')
  }

  const complete = dependencies.completeLogin ?? completeLoginAttempt

  try {
    const created = await complete(
      {
        database: dependencies.database,
        clientIp: auth.clientIp,
        challengeId: parsed.data.challengeId,
        csrfSecret: parsed.data.csrfSecret,
        email: parsed.data.email,
        password: parsed.data.password,
        previousSessionHash: parsed.data.previousSessionHash,
        rateLimitKey: dependencies.rateLimitHmacKey,
        sessionKey: dependencies.sessionTokenKey,
        supabaseUrl: dependencies.supabaseUrl,
        anonKey: dependencies.supabaseAnonKey,
      },
      dependencies.loginDependencies,
    )

    if (
      !isLoginChallengeValue(created?.sessionId) ||
      !isLoginChallengeValue(created?.csrfSecret) ||
      created.sessionId === created.csrfSecret
    ) {
      return failure(500, 'internal_error')
    }

    return {
      status: 200,
      body: {
        sessionId: created.sessionId,
        csrfSecret: created.csrfSecret,
      },
    }
  } catch (error) {
    if (error instanceof CompleteLoginError) {
      const mapped = LOGIN_HTTP[error.code]
      return mapped
        ? failure(mapped.status, mapped.code)
        : failure(500, 'internal_error')
    }

    return failure(500, 'internal_error')
  }
}

function isLoginEmail(value) {
  try {
    normalizeLoginEmail(value)
    return true
  } catch {
    return false
  }
}

function failure(status, code) {
  return { status, body: { code } }
}
