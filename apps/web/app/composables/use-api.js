const GENERIC_ERROR = {
  code: 'REQUEST_FAILED',
  message: 'Request failed',
}

const NETWORK_ERROR = {
  code: 'NETWORK_ERROR',
  message: 'Network request failed',
}

export function buildApiUrl(apiBase, path) {
  if (typeof apiBase !== 'string' || typeof path !== 'string') {
    return null
  }

  let base

  try {
    base = new URL(apiBase.endsWith('/') ? apiBase : `${apiBase}/`)
  } catch {
    return null
  }

  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return null
  }

  let url

  try {
    url = new URL(path.replace(/^\/+/, ''), base)
  } catch {
    return null
  }

  const basePath = base.pathname.endsWith('/')
    ? base.pathname
    : `${base.pathname}/`

  if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) {
    return null
  }

  return url.href
}

export async function requestApi(
  apiBase,
  path,
  options = {},
  dependencies = {},
) {
  const url = buildApiUrl(apiBase, path)

  if (!url) {
    return { data: null, error: GENERIC_ERROR, status: 0 }
  }

  const headers = new Headers(options.headers ?? {})
  const body = encodeBody(options.body, headers)
  const fetchImpl = dependencies.fetch ?? globalThis.fetch

  try {
    const response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
    })
    const text = await response.text()
    const parsed = parseJson(text)

    if (!response.ok) {
      return {
        data: null,
        error: publicError(parsed),
        status: response.status,
      }
    }

    if (text === '') {
      return { data: null, error: null, status: response.status }
    }

    if (parsed === undefined) {
      return { data: null, error: GENERIC_ERROR, status: response.status }
    }

    return { data: parsed, error: null, status: response.status }
  } catch {
    return { data: null, error: NETWORK_ERROR, status: 0 }
  }
}

export function useApi() {
  const apiBase = useRuntimeConfig().public.apiBase

  return {
    request(path, options) {
      return requestApi(apiBase, path, options)
    },
  }
}

function encodeBody(body, headers) {
  if (body === undefined || body === null) {
    return undefined
  }

  if (typeof body === 'string') {
    return body
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return JSON.stringify(body)
}

function parseJson(text) {
  if (text === '') {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function publicError(body) {
  const error = body && typeof body === 'object' ? body.error : null
  const code =
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : null
  const message =
    typeof error?.message === 'string' &&
    error.message.length > 0 &&
    error.message.length <= 300 &&
    !/[\r\n]/.test(error.message)
      ? error.message
      : null

  if (!code || !message) {
    return GENERIC_ERROR
  }

  return { code, message }
}
