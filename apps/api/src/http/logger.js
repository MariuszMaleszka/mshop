function redact(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b(password|secret|token|api[_-]?key)\b\s*[=:]\s*[^&\s]+/gi,
      '$1=[redacted]',
    )
    .replace(
      /shop_guest_session(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?[^\s;,"'\\]*/gi,
      'shop_guest_session=[redacted]',
    )
}

function defaultWrite(level, line) {
  if (level === 'error') {
    console.error(line)
    return
  }

  if (level === 'warn') {
    console.warn(line)
    return
  }

  console.log(line)
}

const FIELD_NAMES = new Set([
  'requestId',
  'method',
  'path',
  'status',
  'durationMs',
  'code',
  'detail',
])

function safeFields(fields) {
  const safe = {}

  if (!fields || typeof fields !== 'object') {
    return safe
  }

  for (const name of FIELD_NAMES) {
    if (fields[name] === undefined) {
      continue
    }

    const value = fields[name]
    safe[name] = typeof value === 'string' ? redact(value) : value
  }

  return safe
}

export function createLogger({
  nodeEnv = 'development',
  write = defaultWrite,
} = {}) {
  const silent = nodeEnv === 'test'

  function writeLog(level, message, fields) {
    if (silent) {
      return
    }

    const line = redact(
      JSON.stringify({
        level,
        message,
        ...safeFields(fields),
      }),
    )

    write(level, line)
  }

  return {
    info(message, fields) {
      writeLog('info', message, fields)
    },
    warn(message, fields) {
      writeLog('warn', message, fields)
    },
    error(message, fields) {
      writeLog('error', message, fields)
    },
  }
}
