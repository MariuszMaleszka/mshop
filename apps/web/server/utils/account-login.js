import { buildApiUrl } from '../../app/composables/use-api.js'
import { checkRequestSource } from '../../app/modules/request-source/check-request-source.js'
import { readCookieValue } from '../../app/modules/request-source/read-cookie.js'
import { normalizeLoginEmail } from '../../../api/src/account-session/rate-limit.js'
import { sha256Hex } from '../../../api/src/account-session/repository.js'
import { prepareInternalCallFromRequest } from './internal-call.js'

const SESSION_MAX_AGE = 12 * 60 * 60
const LOCAL_CHALLENGE_COOKIE = 'mshop_login'
const PRODUCTION_CHALLENGE_COOKIE = '__Host-mshop_login'
const LOCAL_SESSION_COOKIE = 'mshop_session'
const PRODUCTION_SESSION_COOKIE = '__Host-mshop_session'

const EXPRESS_STATUS = {
  400: { status: 400, code: 'invalid_request' },
  401: { status: 401, code: 'invalid_credentials' },
  403: { status: 403, code: 'forbidden' },
  429: { status: 429, code: 'rate_limited' },
  500: { status: 500, code: 'internal_error' },
  503: { status: 503, code: 'unavailable' },
}

export async function loginAccount({
  origin,
  referer,
  cookieHeader,
  csrfToken,
  readBody,
  request,
  allowedOrigin,
  secret,
  apiBase,
  nodeEnv,
  fetchImpl = fetch,
  commitSessionCookie,
}) {
  const source = checkRequestSource({ origin, referer, allowedOrigin })

  if (!source.ok) {
    return source.reason === 'invalid_config'
      ? failure(503, 'unavailable')
      : failure(403, 'forbidden')
  }

  const challengeName = challengeCookieName(nodeEnv)
  const challenge = readCookieValue(cookieHeader, challengeName)

  if (challenge.status !== 'present') {
    return failure(403, 'forbidden')
  }

  const csrf = readCookieValue(
    `${LOCAL_CHALLENGE_COOKIE}=${headerText(csrfToken)}`,
    LOCAL_CHALLENGE_COOKIE,
  )

  if (csrf.status !== 'present') {
    return failure(403, 'forbidden')
  }

  const credentials = await readCredentials(readBody)

  if (!credentials.ok) {
    return failure(400, 'invalid_request')
  }

  const previousSessionHash = readPreviousSessionHash(cookieHeader, nodeEnv)
  const internal = prepareInternalCallFromRequest(request, { secret })

  if (!internal.ok) {
    return failure(503, 'unavailable')
  }

  const url = buildApiUrl(apiBase, 'internal/login')

  if (!url) {
    return failure(503, 'unavailable')
  }

  const payload = {
    challengeId: challenge.value,
    csrfSecret: csrf.value,
    email: credentials.email,
    password: credentials.password,
  }

  if (previousSessionHash) {
    payload.previousSessionHash = previousSessionHash
  }

  let response

  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...internal.headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch {
    return clearedFailure(503, 'unavailable', nodeEnv)
  }

  if (response.status !== 200) {
    return failureFromExpress(response.status, nodeEnv)
  }

  const issued = await readIssuedSession(response)

  if (!issued.ok) {
    if (issued.sessionId) {
      await discardSession({
        apiBase,
        headers: internal.headers,
        sessionId: issued.sessionId,
        fetchImpl,
      })
    }

    return clearedFailure(503, 'unavailable', nodeEnv)
  }

  const sessionCookie = accountSessionCookie(nodeEnv, issued.sessionId)

  if (!sessionCookie) {
    await discardSession({
      apiBase,
      headers: internal.headers,
      sessionId: issued.sessionId,
      fetchImpl,
    })
    return clearedFailure(503, 'unavailable', nodeEnv)
  }

  try {
    if (typeof commitSessionCookie !== 'function') {
      throw new Error('Session cookie was not stored')
    }

    commitSessionCookie(sessionCookie)
  } catch {
    await discardSession({
      apiBase,
      headers: internal.headers,
      sessionId: issued.sessionId,
      fetchImpl,
    })
    return clearedFailure(503, 'unavailable', nodeEnv)
  }

  return {
    status: 200,
    body: { csrfSecret: issued.csrfSecret },
    clearChallenge: true,
    challengeCookie: clearChallengeCookie(nodeEnv),
  }
}

export function accountSessionCookie(nodeEnv, sessionId) {
  const production = nodeEnv === 'production'
  const name = production ? PRODUCTION_SESSION_COOKIE : LOCAL_SESSION_COOKIE
  const parsed = readCookieValue(`${name}=${sessionId}`, name)

  if (parsed.status !== 'present') {
    return null
  }

  return {
    name,
    value: parsed.value,
    options: cookieOptions(production, SESSION_MAX_AGE),
  }
}

export function clearChallengeCookie(nodeEnv) {
  const production = nodeEnv === 'production'

  return {
    name: production ? PRODUCTION_CHALLENGE_COOKIE : LOCAL_CHALLENGE_COOKIE,
    options: cookieOptions(production),
  }
}

function challengeCookieName(nodeEnv) {
  return nodeEnv === 'production'
    ? PRODUCTION_CHALLENGE_COOKIE
    : LOCAL_CHALLENGE_COOKIE
}

function cookieOptions(production, maxAge) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  }
}

function readPreviousSessionHash(cookieHeader, nodeEnv) {
  const name =
    nodeEnv === 'production' ? PRODUCTION_SESSION_COOKIE : LOCAL_SESSION_COOKIE
  const parsed = readCookieValue(cookieHeader, name)

  if (parsed.status !== 'present') {
    return undefined
  }

  return sha256Hex(parsed.value)
}

async function readCredentials(readBody) {
  let body

  try {
    body = await readBody()
  } catch {
    return { ok: false }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false }
  }

  const keys = Object.keys(body)

  if (
    keys.length !== 2 ||
    !keys.includes('email') ||
    !keys.includes('password') ||
    !isLoginEmail(body.email) ||
    typeof body.password !== 'string' ||
    body.password.length === 0
  ) {
    return { ok: false }
  }

  return { ok: true, email: body.email, password: body.password }
}

function isLoginEmail(value) {
  try {
    normalizeLoginEmail(value)
    return true
  } catch {
    return false
  }
}

async function readIssuedSession(response) {
  let body

  try {
    body = await response.json()
  } catch {
    return { ok: false }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false }
  }

  const keys = Object.keys(body)

  if (
    keys.length !== 2 ||
    !keys.includes('sessionId') ||
    !keys.includes('csrfSecret')
  ) {
    const session = readCookieValue(
      `${LOCAL_SESSION_COOKIE}=${headerText(body.sessionId)}`,
      LOCAL_SESSION_COOKIE,
    )

    return {
      ok: false,
      sessionId: session.status === 'present' ? session.value : undefined,
    }
  }

  const session = readCookieValue(
    `${LOCAL_SESSION_COOKIE}=${body.sessionId}`,
    LOCAL_SESSION_COOKIE,
  )
  const csrf = readCookieValue(
    `${LOCAL_CHALLENGE_COOKIE}=${body.csrfSecret}`,
    LOCAL_CHALLENGE_COOKIE,
  )

  if (
    session.status !== 'present' ||
    csrf.status !== 'present' ||
    session.value === csrf.value
  ) {
    return {
      ok: false,
      sessionId: session.status === 'present' ? session.value : undefined,
    }
  }

  return { ok: true, sessionId: session.value, csrfSecret: csrf.value }
}

async function discardSession({ apiBase, headers, sessionId, fetchImpl }) {
  const url = buildApiUrl(apiBase, 'internal/login-sessions/discard')

  if (!url) {
    return
  }

  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionHash: sha256Hex(sessionId) }),
    })
  } catch {
    // The browser still receives a failure. The row expires by its own limits.
  }
}

function failureFromExpress(status, nodeEnv) {
  const mapped = EXPRESS_STATUS[status]

  if (!mapped) {
    return clearedFailure(500, 'internal_error', nodeEnv)
  }

  return clearedFailure(mapped.status, mapped.code, nodeEnv)
}

function clearedFailure(status, code, nodeEnv) {
  return failure(status, code, { clearChallenge: true, nodeEnv })
}

function failure(status, code, options = {}) {
  return {
    status,
    body: { code },
    clearChallenge: options.clearChallenge === true,
    challengeCookie: options.clearChallenge
      ? clearChallengeCookie(options.nodeEnv)
      : null,
  }
}

function headerText(value) {
  return typeof value === 'string' ? value : ''
}
