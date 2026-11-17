import { HttpError } from '../http/errors.js'

const ADMIN_ROLE_SQL =
  "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1"

export function requireAdmin(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('requireAdmin requires a database')
  }

  return async function requireAdminMiddleware(req, _res, next) {
    const userId = req.auth?.userId

    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new HttpError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        logMessage: 'auth.admin_unauthenticated',
      })
    }

    let result

    try {
      result = await database.query(ADMIN_ROLE_SQL, [userId])
    } catch {
      throw new HttpError({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable',
        logMessage: 'auth.admin_check_failed',
      })
    }

    if (!Array.isArray(result?.rows)) {
      throw new HttpError({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable',
        logMessage: 'auth.admin_check_failed',
      })
    }

    if (result.rows.length === 0) {
      throw new HttpError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Insufficient permissions',
        logMessage: 'auth.admin_forbidden',
      })
    }

    next()
  }
}
