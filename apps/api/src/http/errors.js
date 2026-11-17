export class HttpError extends Error {
  constructor({ status, code, message, details = [], logMessage } = {}) {
    const clientMessage =
      typeof message === 'string' && message.trim()
        ? message.trim()
        : 'Request failed'

    super(clientMessage)
    this.name = 'HttpError'

    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError('HttpError status must be an integer from 400 to 599')
    }

    this.status = status
    this.code =
      typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'HTTP_ERROR'
    this.details = Array.isArray(details) ? details : []
    this.logMessage = typeof logMessage === 'string' ? logMessage : undefined
  }
}

export function errorBody(code, message, details = []) {
  return {
    error: {
      code,
      message,
      details,
    },
  }
}
