import { z } from 'zod'
import {
  authenticateInternalRequest,
  internalCallHttpResult,
} from '../http/internal-call.js'
import { deleteAccountSession } from './repository.js'

export const DISCARD_LOGIN_SESSION_PATH =
  '/api/v1/internal/login-sessions/discard'

const discardBodySchema = z
  .object({
    sessionHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export async function handleDiscardLoginSession(request, dependencies = {}) {
  const auth = authenticateInternalRequest(request, {
    secret: dependencies.bffInternalSecret,
    trustedPeers: dependencies.bffTrustedPeers,
  })

  if (!auth.ok) {
    return internalCallHttpResult(auth)
  }

  const parsed = discardBodySchema.safeParse(request?.body)

  if (!parsed.success) {
    return { status: 400, body: { code: 'invalid_request' } }
  }

  try {
    await deleteAccountSession(dependencies.database, parsed.data.sessionHash)
  } catch {
    return { status: 503, body: { code: 'unavailable' } }
  }

  return { status: 200, body: { code: 'discarded' } }
}
