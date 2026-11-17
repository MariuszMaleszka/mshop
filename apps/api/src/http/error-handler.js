import { HttpError, errorBody } from './errors.js'

function clientError(res, status, code, message, details = []) {
  res.status(status).json(errorBody(code, message, details))
}

export function notFoundHandler(_req, res) {
  clientError(res, 404, 'NOT_FOUND', 'Resource not found')
}

export function errorHandler(logger) {
  return function apiErrorHandler(err, req, res, next) {
    if (res.headersSent) {
      next(err)
      return
    }

    const requestId = req.requestId

    if (err?.type === 'entity.parse.failed') {
      logger.warn('request.json', { requestId })
      clientError(res, 400, 'VALIDATION_ERROR', 'Request validation failed')
      return
    }

    if (err instanceof HttpError) {
      logger.warn('request.http_error', {
        requestId,
        status: err.status,
        code: err.code,
        detail: err.logMessage,
      })
      clientError(res, err.status, err.code, err.message, err.details)
      return
    }

    logger.error('request.unhandled', {
      requestId,
      detail: typeof err?.message === 'string' ? err.message : 'Unhandled API error',
    })
    clientError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
}
