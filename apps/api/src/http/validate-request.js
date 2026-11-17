import { HttpError } from './errors.js'

const REQUEST_PARTS = ['body', 'params', 'query']

export function validateRequest(schemas = {}) {
  for (const part of Object.keys(schemas)) {
    if (!REQUEST_PARTS.includes(part)) {
      throw new TypeError(`Unsupported request part: ${part}`)
    }

    if (!schemas[part] || typeof schemas[part].safeParse !== 'function') {
      throw new TypeError(`Schema for ${part} must be a Zod schema`)
    }
  }

  return function validateRequestMiddleware(req, _res, next) {
    const validated =
      req.validated && typeof req.validated === 'object' ? { ...req.validated } : {}
    const details = []

    for (const part of REQUEST_PARTS) {
      const schema = schemas[part]

      if (!schema) {
        continue
      }

      const result = schema.safeParse(req[part])

      if (!result.success) {
        details.push(...publicIssues(part, result.error?.issues))
        continue
      }

      validated[part] = result.data
    }

    if (details.length > 0) {
      throw new HttpError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details,
        logMessage: 'request.validation',
      })
    }

    req.validated = validated
    next()
  }
}

function publicIssues(location, issues) {
  if (!Array.isArray(issues)) {
    return [
      {
        location,
        path: '',
        code: 'custom',
        message: 'Invalid request data',
      },
    ]
  }

  return issues.map((issue) => ({
    location,
    path: issuePath(issue?.path),
    code: typeof issue?.code === 'string' ? issue.code : 'custom',
    message:
      typeof issue?.message === 'string' && issue.message.trim()
        ? issue.message
        : 'Invalid request data',
  }))
}

function issuePath(path) {
  if (!Array.isArray(path)) {
    return ''
  }

  return path
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join('.')
}
