import { P24DataError, P24ResponseError } from './errors.js'

const INT64_MAX = 9223372036854775807n
const MAX_RESPONSE_CHARS = 1_000_000

export function canonicalJson(entries) {
  return `{${entries
    .map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`)
    .join(',')}}`
}

export function encodeJsonString(value, field) {
  if (typeof value !== 'string') {
    throw new P24DataError(`${field} must be a string`)
  }

  return JSON.stringify(value)
}

export function encodeJsonInteger(value, field) {
  return decimalInteger(value, field)
}

export function decimalInteger(value, field) {
  let digits

  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new P24DataError(`${field} must be a non-negative integer`)
    }

    digits = value.toString()
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    digits = value
  } else {
    throw new P24DataError(`${field} must be a decimal integer`)
  }

  if (BigInt(digits) > INT64_MAX) {
    throw new P24DataError(`${field} exceeds int64`)
  }

  return digits
}

export function parseJsonWithIntegerStrings(text) {
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) {
    throw new P24ResponseError('Przelewy24 response is not JSON')
  }

  try {
    return JSON.parse(rewriteIntegersAsStrings(text))
  } catch (error) {
    if (error instanceof P24ResponseError) {
      throw error
    }

    throw new P24ResponseError('Przelewy24 response is not JSON')
  }
}

function rewriteIntegersAsStrings(text) {
  let result = ''
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === '"') {
      const end = readJsonString(text, index)
      result += text.slice(index, end)
      index = end
      continue
    }

    if (char === '-' || isDigit(char)) {
      const end = readJsonNumber(text, index)
      const raw = text.slice(index, end)

      if (/^-?(0|[1-9][0-9]*)$/.test(raw)) {
        result += JSON.stringify(raw)
      } else {
        result += raw
      }

      index = end
      continue
    }

    result += char
    index += 1
  }

  return result
}

function readJsonString(text, start) {
  let index = start + 1

  while (index < text.length) {
    const char = text[index]

    if (char === '\\') {
      index += 2
      continue
    }

    if (char === '"') {
      return index + 1
    }

    index += 1
  }

  throw new P24ResponseError('Przelewy24 response is not JSON')
}

function readJsonNumber(text, start) {
  let index = start + 1

  while (index < text.length && /[0-9.eE+-]/.test(text[index])) {
    index += 1
  }

  return index
}

function isDigit(char) {
  return char >= '0' && char <= '9'
}
