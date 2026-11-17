import { HttpError } from '../http/errors.js'

export function requireAuth(verifier) {
  if (!verifier || typeof verifier.verifyAccessToken !== 'function') {
    throw new TypeError('requireAuth requires an access token verifier')
  }

  return async function requireAuthMiddleware(req, _res, next) {
    const credential = readBearerToken(req.get('authorization'))

    if (credential.error) {
      throw new HttpError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        logMessage: credential.error,
      })
    }

    const userId = await verifier.verifyAccessToken(credential.token)
    req.auth = { userId }
    next()
  }
}

function readBearerToken(header) {
  if (typeof header !== 'string' || header.length === 0) {
    return { error: 'auth.missing_token' }
  }

  const match = /^Bearer (\S+)$/.exec(header)

  if (!match) {
    return { error: 'auth.invalid_token' }
  }

  return { token: match[1] }
}
