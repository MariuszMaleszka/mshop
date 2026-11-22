import { buildApiUrl } from '../../app/composables/use-api.js'
import { checkRequestSource } from '../../app/modules/request-source/check-request-source.js'
import { readCookieValue } from '../../app/modules/request-source/read-cookie.js'
import { prepareInternalCallFromRequest } from './internal-call.js'

const CHALLENGE_COOKIE_MAX_AGE = 600
const LOCAL_COOKIE = 'mshop_login'
const PRODUCTION_COOKIE = '__Host-mshop_login'

export function readAllowedOrigin({ env = {}, runtimeConfig = {} } = {}) {
  const override = runtimeConfig.bffAllowedOrigin

  if (typeof override === 'string' && override !== '') {
    return override
  }

  return typeof env.WEB_ORIGIN === 'string' ? env.WEB_ORIGIN : ''
}

export function loginChallengeCookie(nodeEnv, challengeId) {
  const production = nodeEnv === 'production'
  const name = production ? PRODUCTION_COOKIE : LOCAL_COOKIE
  const parsed = readCookieValue(`${name}=${challengeId}`, name)

  if (parsed.status !== 'present') {
    return null
  }

  return {
    name,
    value: parsed.value,
    options: {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      path: '/',
      maxAge: CHALLENGE_COOKIE_MAX_AGE,
    },
  }
}

export async function bootstrapCsrfChallenge({
  origin,
  referer,
  request,
  allowedOrigin,
  secret,
  apiBase,
  nodeEnv,
  fetchImpl = fetch,
}) {
  const source = checkRequestSource({ origin, referer, allowedOrigin })

  if (!source.ok) {
    return source.reason === 'invalid_config'
      ? failure(503, 'unavailable')
      : failure(403, 'forbidden')
  }

  const internal = prepareInternalCallFromRequest(request, { secret })

  if (!internal.ok) {
    return failure(503, 'unavailable')
  }

  const url = buildApiUrl(apiBase, 'internal/login-challenges')

  if (!url) {
    return failure(503, 'unavailable')
  }

  let response

  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: internal.headers,
    })
  } catch {
    return failure(503, 'unavailable')
  }

  if (response.status === 429) {
    return failure(429, 'rate_limited')
  }

  if (response.status !== 200) {
    return failure(503, 'unavailable')
  }

  let body

  try {
    body = await response.json()
  } catch {
    return failure(503, 'unavailable')
  }

  const cookie = acceptIssuedChallenge(body, nodeEnv)

  if (!cookie) {
    return failure(503, 'unavailable')
  }

  return {
    status: 200,
    body: { csrfSecret: cookie.secret },
    cookie: cookie.cookie,
  }
}

function acceptIssuedChallenge(body, nodeEnv) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const keys = Object.keys(body)

  if (
    keys.length !== 2 ||
    !keys.includes('challengeId') ||
    !keys.includes('csrfSecret')
  ) {
    return null
  }

  const cookie = loginChallengeCookie(nodeEnv, body.challengeId)
  const secret = readCookieValue(
    `${LOCAL_COOKIE}=${body.csrfSecret}`,
    LOCAL_COOKIE,
  )

  if (!cookie || secret.status !== 'present' || secret.value === cookie.value) {
    return null
  }

  return { cookie, secret: secret.value }
}

function failure(status, code) {
  return { status, body: { code }, cookie: null }
}
