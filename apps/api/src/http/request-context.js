import { randomUUID } from 'node:crypto'

export function requestContext(logger) {
  return function requestContextMiddleware(req, res, next) {
    const requestId = randomUUID()
    const startedAt = Date.now()
    const path = req.path || '/'

    req.requestId = requestId
    res.setHeader('X-Request-Id', requestId)

    res.on('finish', () => {
      logger.info('request', {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      })
    })

    next()
  }
}
