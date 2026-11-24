let challengeSecret = null

export function rememberLoginCsrf(value) {
  challengeSecret = isCsrfSecret(value) ? value : null
}

export function readLoginCsrf() {
  return challengeSecret
}

export function clearLoginCsrf() {
  challengeSecret = null
}

function isCsrfSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}
