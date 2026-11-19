export class P24DataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'P24DataError'
  }
}

export class P24HttpError extends Error {
  constructor(status) {
    super('Przelewy24 request was rejected')
    this.name = 'P24HttpError'
    this.status = status
  }
}

export class P24NetworkError extends Error {
  constructor() {
    super('Przelewy24 network request failed')
    this.name = 'P24NetworkError'
  }
}

export class P24TimeoutError extends Error {
  constructor() {
    super('Przelewy24 request timed out')
    this.name = 'P24TimeoutError'
  }
}

export class P24ResponseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'P24ResponseError'
  }
}
