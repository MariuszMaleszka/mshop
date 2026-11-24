const REFRESH_GRANT_PATH = '/auth/v1/token?grant_type=refresh_token'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REJECTED_CODES = new Set([
  'invalid_grant',
  'refresh_token_not_found',
  'session_not_found',
])

export const REFRESH_AUTH_TIMEOUT_MS = 8000

export class RefreshAuthError extends Error {
  constructor(code) {
    super('Supabase refresh failed')
    this.name = 'RefreshAuthError'
    this.code = code
  }
}

export async function refreshSupabaseSession({
  supabaseUrl,
  anonKey,
  refreshToken,
  fetchImpl = fetch,
  timeoutMs = REFRESH_AUTH_TIMEOUT_MS,
} = {}) {
  const url = refreshGrantUrl(supabaseUrl)

  if (!url || !isSecret(anonKey) || typeof fetchImpl !== 'function') {
    throw new RefreshAuthError('configuration')
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RefreshAuthError('configuration')
  }

  if (!isSecret(refreshToken)) {
    throw new RefreshAuthError('rejected')
  }

  const signal = AbortSignal.timeout(timeoutMs)
  let response

  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal,
    })
  } catch (error) {
    if (isTimeout(error, signal)) {
      throw new RefreshAuthError('timeout')
    }

    throw new RefreshAuthError('unavailable')
  }

  if (signal.aborted) {
    throw new RefreshAuthError('timeout')
  }

  if (response?.status === 200) {
    return readSession(response)
  }

  if (typeof response?.status !== 'number' || response.status >= 500) {
    throw new RefreshAuthError('unavailable')
  }

  if (await isRefreshRejection(response)) {
    throw new RefreshAuthError('rejected')
  }

  throw new RefreshAuthError('unavailable')
}

function refreshGrantUrl(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    return null
  }

  let url

  try {
    url = new URL(supabaseUrl)
  } catch {
    return null
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    return null
  }

  return `${url.origin}${REFRESH_GRANT_PATH}`
}

async function readSession(response) {
  const body = await readJson(response)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RefreshAuthError('invalid_response')
  }

  const user = body.user
  const userId = user && typeof user === 'object' ? user.id : undefined

  if (
    !isToken(body.access_token) ||
    !isToken(body.refresh_token) ||
    !isUnixTime(body.expires_at) ||
    typeof userId !== 'string' ||
    !UUID_PATTERN.test(userId)
  ) {
    throw new RefreshAuthError('invalid_response')
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
    userId,
  }
}

async function isRefreshRejection(response) {
  if (response.status === 401 || response.status === 403) {
    return true
  }

  if (response.status !== 400) {
    return false
  }

  const body = await readJson(response)

  if (!body || typeof body !== 'object') {
    return true
  }

  return [body.error_code, body.error, body.code].some(
    (value) => typeof value === 'string' && REJECTED_CODES.has(value),
  )
}

async function readJson(response) {
  if (typeof response?.json !== 'function') {
    return null
  }

  try {
    return await response.json()
  } catch {
    return null
  }
}

function isSecret(value) {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value)
}

function isToken(value) {
  return typeof value === 'string' && value.length > 0
}

function isUnixTime(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTimeout(error, signal) {
  return (
    signal?.aborted === true ||
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError'
  )
}
