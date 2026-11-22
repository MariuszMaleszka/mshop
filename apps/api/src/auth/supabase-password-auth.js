const PASSWORD_GRANT_PATH = '/auth/v1/token?grant_type=password'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CREDENTIAL_CODES = new Set([
  'invalid_credentials',
  'invalid_grant',
  'user_not_found',
])

export const PASSWORD_AUTH_TIMEOUT_MS = 8000

export class PasswordAuthError extends Error {
  constructor(code) {
    super('Password authentication failed')
    this.name = 'PasswordAuthError'
    this.code = code
  }
}

export async function signInWithPassword({
  supabaseUrl,
  anonKey,
  email,
  password,
  fetchImpl = fetch,
  timeoutMs = PASSWORD_AUTH_TIMEOUT_MS,
} = {}) {
  const url = passwordGrantUrl(supabaseUrl)

  if (!url || !isSecret(anonKey) || typeof fetchImpl !== 'function') {
    throw new PasswordAuthError('configuration')
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PasswordAuthError('configuration')
  }

  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new PasswordAuthError('invalid_credentials')
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
      body: JSON.stringify({ email, password }),
      signal,
    })
  } catch (error) {
    if (isTimeout(error, signal)) {
      throw new PasswordAuthError('timeout')
    }

    throw new PasswordAuthError('unavailable')
  }

  if (signal.aborted) {
    throw new PasswordAuthError('timeout')
  }

  if (response?.status === 200) {
    return readSession(response)
  }

  if (typeof response?.status !== 'number' || response.status >= 500) {
    throw new PasswordAuthError('unavailable')
  }

  if (await isCredentialRejection(response)) {
    throw new PasswordAuthError('invalid_credentials')
  }

  throw new PasswordAuthError('rejected')
}

function passwordGrantUrl(supabaseUrl) {
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

  return `${url.origin}${PASSWORD_GRANT_PATH}`
}

function isSecret(value) {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value)
}

async function readSession(response) {
  const body = await readJson(response)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PasswordAuthError('invalid_response')
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
    throw new PasswordAuthError('invalid_response')
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
    userId,
  }
}

async function isCredentialRejection(response) {
  const body = await readJson(response)

  if (!body || typeof body !== 'object') {
    return false
  }

  return [body.error_code, body.error, body.code].some(
    (value) => typeof value === 'string' && CREDENTIAL_CODES.has(value),
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
