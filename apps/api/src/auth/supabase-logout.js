const LOGOUT_PATH = '/auth/v1/logout?scope=local'

export const LOGOUT_TIMEOUT_MS = 8000

export class SupabaseLogoutError extends Error {
  constructor(code) {
    super('Supabase logout failed')
    this.name = 'SupabaseLogoutError'
    this.code = code
  }
}

export async function revokeSupabaseSession({
  supabaseUrl,
  anonKey,
  accessToken,
  fetchImpl = fetch,
  timeoutMs = LOGOUT_TIMEOUT_MS,
} = {}) {
  const url = logoutUrl(supabaseUrl)

  if (
    !url ||
    !isHeaderSecret(anonKey) ||
    !isHeaderSecret(accessToken) ||
    typeof fetchImpl !== 'function' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new SupabaseLogoutError('configuration')
  }

  const signal = AbortSignal.timeout(timeoutMs)
  let response

  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
      },
      signal,
    })
  } catch {
    return { outcome: 'unknown' }
  }

  if (signal.aborted) {
    return { outcome: 'unknown' }
  }

  await discardBody(response)

  if (response?.status === 204) {
    return { outcome: 'revoked' }
  }

  if (
    response?.status === 400 ||
    response?.status === 401 ||
    response?.status === 403
  ) {
    return { outcome: 'rejected' }
  }

  return { outcome: 'unknown' }
}

function logoutUrl(supabaseUrl) {
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

  return `${url.origin}${LOGOUT_PATH}`
}

function isHeaderSecret(value) {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value)
}

async function discardBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    // The status code is the only logout result we keep.
  }
}
