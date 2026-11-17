import express from 'express'

const DEFAULT_WEB_ORIGIN = 'http://localhost:3000'

export function createApp() {
  const app = express()
  const webOrigin = process.env.WEB_ORIGIN || DEFAULT_WEB_ORIGIN

  app.disable('x-powered-by')
  app.use(express.json())
  app.use((req, res, next) => {
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
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    next()
  })

  app.get('/api/v1/health', (_req, res) => {
    res.status(200).json({
      data: { status: 'ok' },
      meta: {},
    })
  })

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        details: [],
      },
    })
  })

  app.use((err, _req, res, next) => {
    if (res.headersSent) {
      next(err)
      return
    }

    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: [],
        },
      })
      return
    }

    console.error('Unhandled API error')

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      },
    })
  })

  return app
}
