import { buildApiUrl } from '../../app/composables/use-api.js'
import { readAccountSession } from './read-account-session.js'

const ORDER_TIMEOUT_MS = 8000
const QUERY_KEYS = [
  'page',
  'limit',
  'search',
  'paymentStatus',
  'fulfillmentStatus',
  'paymentMethod',
  'sortBy',
  'sortOrder',
]

// Same acceptance rule as Express z.uuid() for this route.
const ORDER_ID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/

const UPSTREAM_CODES = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  503: 'SERVICE_UNAVAILABLE',
}

export async function loadAdminOrderList(event, options = {}) {
  try {
    const session = await readSession(event, options)

    if (!session.ok) {
      return session.result
    }

    const query = listQuery(event)

    if (!query.ok) {
      return validationFailure()
    }

    return await readUpstream({
      path: `admin/orders${query.search}`,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      accessToken: session.accessToken,
      secrets: session.secrets,
      acceptData: Array.isArray,
    })
  } catch {
    return unavailable()
  }
}

export async function loadAdminOrderDetail(event, options = {}) {
  try {
    const orderId = routeOrderId(event)

    if (!ORDER_ID.test(orderId)) {
      return validationFailure()
    }

    const session = await readSession(event, options)

    if (!session.ok) {
      return session.result
    }

    return await readUpstream({
      path: `admin/orders/${orderId}`,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      accessToken: session.accessToken,
      secrets: session.secrets,
      acceptData(data) {
        return isPlainObject(data)
      },
    })
  } catch {
    return unavailable()
  }
}

async function readSession(event, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const session = await readAccountSession({
    request: event?.node?.req,
    runtimeConfig: useRuntimeConfig(),
    nodeEnv: process.env.NODE_ENV,
    fetchImpl,
    timeoutMs: options.sessionTimeoutMs,
  })

  if (session.ok !== true) {
    return {
      ok: false,
      result:
        session.code === 'invalid_session' ? unauthorized() : unavailable(),
    }
  }

  return {
    ok: true,
    accessToken: session.accessToken,
    secrets: [
      session.accessToken,
      session.refreshToken,
      cookieValue(event),
      runtimeSecret(),
    ].filter((value) => typeof value === 'string' && value.length > 0),
  }
}

async function readUpstream({
  path,
  fetchImpl = globalThis.fetch,
  timeoutMs = ORDER_TIMEOUT_MS,
  accessToken,
  secrets,
  acceptData,
}) {
  const url = buildApiUrl(useRuntimeConfig()?.public?.apiBase, path)

  if (!url || typeof fetchImpl !== 'function') {
    return unavailable()
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return unavailable()
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response

  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
  } catch {
    return unavailable()
  } finally {
    clearTimeout(timer)
  }

  let body

  try {
    body = await response.json()
  } catch {
    return unavailable()
  }

  if (containsSensitive(body, secrets)) {
    return unavailable()
  }

  if (response.status === 200) {
    return successBody(body, acceptData)
  }

  return errorBody(response.status, body)
}

function listQuery(event) {
  const source = getQuery(event)
  const params = new URLSearchParams()

  if (!isPlainObject(source)) {
    return { ok: false }
  }

  for (const key of QUERY_KEYS) {
    if (!Object.hasOwn(source, key)) {
      continue
    }

    const value = source[key]

    if (typeof value !== 'string') {
      return { ok: false }
    }

    params.append(key, value)
  }

  const search = params.size > 0 ? `?${params.toString()}` : ''
  return { ok: true, search }
}

function routeOrderId(event) {
  const value = getRouterParam(event, 'id')
  return typeof value === 'string' ? value : ''
}

function successBody(body, acceptData) {
  if (
    !isPlainObject(body) ||
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, 'data') ||
    !Object.hasOwn(body, 'meta') ||
    !acceptData(body.data) ||
    !isPlainObject(body.meta)
  ) {
    return unavailable()
  }

  return {
    status: 200,
    body: { data: body.data, meta: body.meta },
  }
}

function errorBody(status, body) {
  const code = UPSTREAM_CODES[status]

  if (!code || !isErrorEnvelope(body, code)) {
    return unavailable()
  }

  if (status === 401) {
    return unauthorized()
  }

  if (status === 403) {
    return failure(403, 'FORBIDDEN', 'Insufficient permissions')
  }

  if (status === 404) {
    return failure(404, 'NOT_FOUND', 'Resource not found')
  }

  if (status === 400) {
    return validationFailure()
  }

  return unavailable()
}

function isErrorEnvelope(body, code) {
  return (
    isPlainObject(body) &&
    Object.keys(body).length === 1 &&
    isPlainObject(body.error) &&
    Object.keys(body.error).length === 3 &&
    body.error.code === code &&
    safeMessage(body.error.message) &&
    Array.isArray(body.error.details)
  )
}

function safeMessage(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    !/[\r\n]/.test(value)
  )
}

function containsSensitive(value, secrets) {
  const visible = JSON.stringify(value)
  return secrets.some((secret) => visible.includes(secret))
}

function cookieValue(event) {
  const value = event?.node?.req?.headers?.cookie
  return typeof value === 'string' ? value : ''
}

function runtimeSecret() {
  const value = useRuntimeConfig()?.bffInternalSecret
  return typeof value === 'string' ? value : ''
}

function validationFailure() {
  return failure(400, 'VALIDATION_ERROR', 'Invalid request data')
}

function unauthorized() {
  return failure(401, 'UNAUTHORIZED', 'Authentication required')
}

function unavailable() {
  return failure(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
}

function failure(status, code, message) {
  return {
    status,
    body: { error: { code, message, details: [] } },
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
