import express from 'express'
import { HttpError } from './http/errors.js'
import { errorHandler, notFoundHandler } from './http/error-handler.js'
import { createLogger } from './http/logger.js'
import { requestContext } from './http/request-context.js'

function cors(webOrigin) {
  return function corsMiddleware(req, res, next) {
    if (req.headers.origin === webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', webOrigin)
      res.setHeader('Vary', 'Origin')
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      )
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization',
      )
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id')
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    next()
  }
}

export function createApp(config, options = {}) {
  const app = express()
  const logger = options.logger ?? createLogger({ nodeEnv: config.nodeEnv })

  app.disable('x-powered-by')
  app.use(express.json())
  app.use(cors(config.webOrigin))
  app.use(requestContext(logger))

  app.get('/api/v1/health', (_req, res) => {
    res.status(200).json({
      data: { status: 'ok' },
      meta: {},
    })
  })

  app.get('/api/v1/health/ready', async (_req, res) => {
    const ready = options.database ? await options.database.checkConnection() : false

    if (!ready) {
      throw new HttpError({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable',
      })
    }

    res.status(200).json({
      data: { status: 'ready' },
      meta: {},
    })
  })

  if (typeof options.registerRoutes === 'function') {
    options.registerRoutes(app)
  }

  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}
