export function checkRequestSource({ origin, referer, allowedOrigin }) {
  const allowed = canonicalOrigin(allowedOrigin, { requireCanonical: true })

  if (!allowed) {
    return { ok: false, reason: 'invalid_config' }
  }

  const presentedOrigin = headerPresent(origin)

  if (presentedOrigin !== undefined) {
    const actual = canonicalOrigin(presentedOrigin, { requireCanonical: true })

    if (actual !== allowed) {
      return { ok: false, reason: 'invalid_source' }
    }

    return { ok: true }
  }

  const presentedReferer = headerPresent(referer)

  if (presentedReferer === undefined) {
    return { ok: false, reason: 'invalid_source' }
  }

  const refererOrigin = canonicalOrigin(presentedReferer, {
    requireCanonical: false,
  })

  if (refererOrigin !== allowed) {
    return { ok: false, reason: 'invalid_source' }
  }

  return { ok: true }
}

function headerPresent(value) {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function canonicalOrigin(value, { requireCanonical }) {
  if (typeof value !== 'string' || value !== value.trim() || value === 'null') {
    return null
  }

  let url

  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.origin === 'null'
  ) {
    return null
  }

  if (requireCanonical) {
    if (
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      return null
    }

    if (value !== url.origin) {
      return null
    }
  }

  return url.origin
}
