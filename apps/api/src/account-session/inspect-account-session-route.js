import { z } from 'zod'
import {
  authenticateInternalRequest,
  internalCallHttpResult,
} from '../http/internal-call.js'
import { AccountSessionInspectError } from './inspect-account-session.js'
import { inspectAndExtendAccountSession } from './inspect-and-extend-account-session.js'

export const INSPECT_ACCOUNT_SESSION_PATH =
  '/api/v1/internal/account-sessions/inspect'

const inspectBodySchema = z
  .object({
    sessionHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

const INVALID_SESSION = new Set([
  'not_found',
  'expired',
  'stale_pending',
  'unknown',
  'invalid',
  'unavailable',
])

export async function handleInspectAccountSession(request, dependencies = {}) {
  const auth = authenticateInternalRequest(request, {
    secret: dependencies.bffInternalSecret,
    trustedPeers: dependencies.bffTrustedPeers,
  })

  if (!auth.ok) {
    return internalCallHttpResult(auth)
  }

  const parsed = inspectBodySchema.safeParse(request?.body)

  if (!parsed.success) {
    return failure(400, 'invalid_request')
  }

  const inspect =
    dependencies.inspectAndExtend ?? inspectAndExtendAccountSession

  try {
    const result = await inspect({
      database: dependencies.database,
      sessionHash: parsed.data.sessionHash,
      key: dependencies.sessionTokenKey,
      rateLimitKey: dependencies.rateLimitHmacKey,
      supabaseUrl: dependencies.supabaseUrl,
      anonKey: dependencies.supabaseAnonKey,
    })

    if (result?.status === 'ready') {
      return readyResponse(result)
    }

    if (result?.status === 'pending') {
      return failure(503, 'session_pending')
    }

    if (result?.status === 'rate_limited') {
      return failure(429, 'rate_limited')
    }

    if (INVALID_SESSION.has(result?.status)) {
      return failure(401, 'invalid_session')
    }

    return failure(500, 'internal_error')
  } catch (error) {
    if (
      error instanceof AccountSessionInspectError &&
      error.code === 'unavailable'
    ) {
      return failure(503, 'service_unavailable')
    }

    return failure(500, 'internal_error')
  }
}

function readyResponse(result) {
  if (
    typeof result.userId !== 'string' ||
    result.userId.length === 0 ||
    typeof result.accessToken !== 'string' ||
    result.accessToken.length === 0 ||
    typeof result.refreshToken !== 'string' ||
    result.refreshToken.length === 0 ||
    !Number.isInteger(result.keyVersion)
  ) {
    return failure(500, 'internal_error')
  }

  return {
    status: 200,
    body: {
      status: 'ready',
      userId: result.userId,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      keyVersion: result.keyVersion,
    },
  }
}

function failure(status, code) {
  return { status, body: { code } }
}
