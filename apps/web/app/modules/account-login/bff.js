import { requestApi } from '../../composables/use-api.js'
import {
  clearLoginCsrf,
  readLoginCsrf,
  rememberLoginCsrf,
} from './csrf-memory.js'
import { csrfErrorMessage, loginErrorMessage } from './messages.js'

export function requestLoginCsrf(origin, dependencies) {
  return requestAuthJson(origin, 'auth/csrf', { method: 'POST' }, dependencies)
}

export function requestAccountLogin(origin, { email, password }, dependencies) {
  const csrfSecret = readLoginCsrf()

  if (!csrfSecret) {
    return Promise.resolve({
      ok: false,
      status: 403,
      message: loginErrorMessage(403),
    })
  }

  return requestAuthJson(
    origin,
    'auth/login',
    {
      method: 'POST',
      headers: {
        'X-CSRF-Token': csrfSecret,
      },
      body: {
        email,
        password,
      },
    },
    dependencies,
  )
}

export async function bootstrapLoginCsrf(origin, dependencies) {
  clearLoginCsrf()
  const result = await requestLoginCsrf(origin, dependencies)

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      message: csrfErrorMessage(result.status),
    }
  }

  rememberLoginCsrf(result.csrfSecret)

  if (!readLoginCsrf()) {
    return {
      ok: false,
      status: 503,
      message: csrfErrorMessage(503),
    }
  }

  return { ok: true, status: 200 }
}

export async function submitAccountLogin(
  origin,
  { email, password },
  dependencies,
) {
  const result = await requestAccountLogin(
    origin,
    { email, password },
    dependencies,
  )

  if (!result.ok) {
    clearLoginCsrf()
    return {
      ok: false,
      status: result.status,
      message: loginErrorMessage(result.status),
    }
  }

  rememberLoginCsrf(result.csrfSecret)

  if (!readLoginCsrf()) {
    clearLoginCsrf()
    return {
      ok: false,
      status: 503,
      message: loginErrorMessage(503),
    }
  }

  return { ok: true, status: 200 }
}

async function requestAuthJson(origin, path, options, dependencies) {
  const result = await requestApi(
    nuxtApiBase(origin),
    path,
    options,
    dependencies,
  )

  if (result.error || result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      status: result.status || 503,
    }
  }

  const csrfSecret = readResponseCsrf(result.data)

  if (!csrfSecret) {
    return {
      ok: false,
      status: 503,
    }
  }

  return {
    ok: true,
    status: result.status,
    csrfSecret,
  }
}

function readResponseCsrf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const keys = Object.keys(body)

  if (keys.length !== 1 || !keys.includes('csrfSecret')) {
    return null
  }

  return typeof body.csrfSecret === 'string' ? body.csrfSecret : null
}

function nuxtApiBase(origin) {
  if (typeof origin !== 'string') {
    return null
  }

  let url

  try {
    url = new URL(origin)
  } catch {
    return null
  }

  if (
    url.origin !== origin ||
    (url.protocol !== 'http:' && url.protocol !== 'https:')
  ) {
    return null
  }

  return `${url.origin}/api/v1`
}
