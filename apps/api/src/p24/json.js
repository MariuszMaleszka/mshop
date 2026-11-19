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

const CANONICAL_INTEGER = /^-?(0|[1-9][0-9]*)$/

class JsonInteger {
  constructor(digits) {
    this.digits = digits
  }
}

class JsonNumber {
  constructor(text) {
    this.text = text
  }
}

export function jsonIntegerDigits(value) {
  return value instanceof JsonInteger ? value.digits : null
}

export function jsonNumberText(value) {
  if (value instanceof JsonInteger) {
    return value.digits
  }

  return value instanceof JsonNumber ? value.text : null
}

export function parseJsonWithIntegerStrings(text) {
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) {
    throw new P24ResponseError('Przelewy24 response is not JSON')
  }

  const parser = new JsonParser(text)
  const value = parser.parseValue()
  parser.skipWhitespace()

  if (!parser.done()) {
    throw new P24ResponseError('Przelewy24 response is not JSON')
  }

  return value
}

class JsonParser {
  constructor(text) {
    this.text = text
    this.index = 0
  }

  parseValue() {
    this.skipWhitespace()
    const char = this.peek()

    if (char === '{') {
      return this.parseObject()
    }

    if (char === '[') {
      return this.parseArray()
    }

    if (char === '"') {
      return this.parseString()
    }

    if (char === 't') {
      return this.parseLiteral('true', true)
    }

    if (char === 'f') {
      return this.parseLiteral('false', false)
    }

    if (char === 'n') {
      return this.parseLiteral('null', null)
    }

    if (char === '-' || isDigit(char)) {
      return this.parseNumber()
    }

    throw new P24ResponseError('Przelewy24 response is not JSON')
  }

  parseObject() {
    this.expect('{')
    const object = {}
    const keys = new Set()
    this.skipWhitespace()

    if (this.peek() === '}') {
      this.index += 1
      return object
    }

    while (this.index < this.text.length) {
      this.skipWhitespace()
      if (this.peek() !== '"') {
        throw new P24ResponseError('Przelewy24 response is not JSON')
      }

      const key = this.parseString()

      if (keys.has(key)) {
        throw new P24ResponseError('Przelewy24 response repeats a JSON key')
      }

      keys.add(key)
      this.skipWhitespace()
      this.expect(':')
      object[key] = this.parseValue()
      this.skipWhitespace()

      if (this.peek() === ',') {
        this.index += 1
        continue
      }

      this.expect('}')
      return object
    }

    throw new P24ResponseError('Przelewy24 response is not JSON')
  }

  parseArray() {
    this.expect('[')
    const values = []
    this.skipWhitespace()

    if (this.peek() === ']') {
      this.index += 1
      return values
    }

    while (this.index < this.text.length) {
      values.push(this.parseValue())
      this.skipWhitespace()

      if (this.peek() === ',') {
        this.index += 1
        continue
      }

      this.expect(']')
      return values
    }

    throw new P24ResponseError('Przelewy24 response is not JSON')
  }

  parseString() {
    this.expect('"')
    let value = ''

    while (this.index < this.text.length) {
      const char = this.text[this.index]
      this.index += 1

      if (char === '"') {
        return value
      }

      if (char === '\\') {
        value += this.parseEscape()
        continue
      }

      if (char.charCodeAt(0) < 0x20) {
        throw new P24ResponseError('Przelewy24 response is not JSON')
      }

      value += char
    }

    throw new P24ResponseError('Przelewy24 response is not JSON')
  }

  parseEscape() {
    const char = this.text[this.index]
    this.index += 1
    const simple = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    }

    if (Object.hasOwn(simple, char)) {
      return simple[char]
    }

    if (char !== 'u') {
      throw new P24ResponseError('Przelewy24 response is not JSON')
    }

    const hex = this.text.slice(this.index, this.index + 4)

    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new P24ResponseError('Przelewy24 response is not JSON')
    }

    this.index += 4
    return String.fromCharCode(Number.parseInt(hex, 16))
  }

  parseNumber() {
    const start = this.index

    if (this.peek() === '-') {
      this.index += 1
    }

    if (!this.consumeInt()) {
      throw new P24ResponseError('Przelewy24 response has an invalid number')
    }

    let canonicalInteger = true

    if (this.peek() === '.') {
      canonicalInteger = false
      this.index += 1

      if (!this.consumeDigits()) {
        throw new P24ResponseError('Przelewy24 response has an invalid number')
      }
    }

    if (this.peek() === 'e' || this.peek() === 'E') {
      canonicalInteger = false
      this.index += 1

      if (this.peek() === '+' || this.peek() === '-') {
        this.index += 1
      }

      if (!this.consumeDigits()) {
        throw new P24ResponseError('Przelewy24 response has an invalid number')
      }
    }

    const text = this.text.slice(start, this.index)

    if (canonicalInteger) {
      if (!CANONICAL_INTEGER.test(text)) {
        throw new P24ResponseError('Przelewy24 response has an invalid number')
      }

      return new JsonInteger(text)
    }

    return new JsonNumber(text)
  }

  consumeInt() {
    if (this.peek() === '0') {
      this.index += 1
      return !isDigit(this.peek())
    }

    return this.consumeDigits()
  }

  consumeDigits() {
    if (!isDigit(this.peek())) {
      return false
    }

    while (isDigit(this.peek())) {
      this.index += 1
    }

    return true
  }

  parseLiteral(expected, value) {
    if (
      this.text.slice(this.index, this.index + expected.length) !== expected
    ) {
      throw new P24ResponseError('Przelewy24 response is not JSON')
    }

    this.index += expected.length
    return value
  }

  skipWhitespace() {
    while (
      this.peek() === ' ' ||
      this.peek() === '\n' ||
      this.peek() === '\r' ||
      this.peek() === '\t'
    ) {
      this.index += 1
    }
  }

  expect(char) {
    if (this.peek() !== char) {
      throw new P24ResponseError('Przelewy24 response is not JSON')
    }

    this.index += 1
  }

  peek() {
    return this.text[this.index]
  }

  done() {
    return this.index >= this.text.length
  }
}

function isDigit(char) {
  return char >= '0' && char <= '9'
}
