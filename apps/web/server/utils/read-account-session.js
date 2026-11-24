import { buildApiUrl } from '../../app/composables/use-api.js'
import { readCookieValue } from '../../app/modules/request-source/read-cookie.js'
import { sha256Hex } from '../../../api/src/account-session/repository.js'
import { accountSessionCookieName } from './account-login.js'
import {
  prepareInternalCallFromRequest,
  serverInternalSecret,
} from './internal-call.js'

const INSPECT_TIMEOUT_MS = 8000
const SESSION_HASH = /^[0-9a-f]{64}$/

export async function readAccountSession({
  request,
  runtimeConfig,
  nodeEnv,
  fetchImpl = fetch,
  timeoutMs = INSPECT_TIMEOUT_MS,
} = {}) {
  const parsed = readCookieValue(
    cookieHeader(request),
    accountSessionCookieName(nodeEnv),
  )

  if (parsed.status !== 'present') {
    return failure('invalid_session')
  }

  const sessionHash = sha256Hex(parsed.value)

  if (!SESSION_HASH.test(sessionHash)) {
    return failure('service_unavailable')
  }

  const internal = prepareInternalCallFromRequest(request, {
    secret: serverInternalSecret(runtimeConfig),
  })

  if (!internal.ok || typeof fetchImpl !== 'function') {
    return failure('service_unavailable')
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure('service_unavailable')
  }

  const url = buildApiUrl(
    runtimeConfig?.public?.apiBase,
    'internal/account-sessions/inspect',
  )

  if (!url) {
    return failure('service_unavailable')
  }

  let response

  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...internal.headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionHash }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return failure('service_unavailable')
  }

  return mapInspectResponse(response)
}

async function mapInspectResponse(response) {
  let body

  try {
    body = await response.json()
  } catch {
    return failure('service_unavailable')
  }

  if (response.status === 200) {
    return readySession(body)
  }

  if (response.status === 401 && exactCode(body, 'invalid_session')) {
    return failure('invalid_session')
  }

  if (response.status === 503 && exactCode(body, 'session_pending')) {
    return failure('session_pending')
  }

  if (response.status === 503 && exactCode(body, 'service_unavailable')) {
    return failure('service_unavailable')
  }

  return failure('service_unavailable')
}

function readySession(body) {
  if (!isPlainObject(body) || Object.keys(body).length !== 5) {
    return failure('service_unavailable')
  }

  if (
    body.status !== 'ready' ||
    typeof body.userId !== 'string' ||
    body.userId.length === 0 ||
    typeof body.accessToken !== 'string' ||
    body.accessToken.length === 0 ||
    typeof body.refreshToken !== 'string' ||
    body.refreshToken.length === 0 ||
    !Number.isInteger(body.keyVersion)
  ) {
    return failure('service_unavailable')
  }

  return {
    ok: true,
    userId: body.userId,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    keyVersion: body.keyVersion,
  }
}

function exactCode(body, code) {
  return (
    isPlainObject(body) && Object.keys(body).length === 1 && body.code === code
  )
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cookieHeader(request) {
  const value = request?.headers?.cookie
  return typeof value === 'string' ? value : undefined
}

function failure(code) {
  return { ok: false, code }
}
