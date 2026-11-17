import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { validateRequest } from '../src/http/validate-request.js'

const bodySchema = z.object({
  name: z.string().trim().min(1),
})
const paramsSchema = z.object({
  id: z.string().uuid(),
})
const querySchema = z.object({
  q: z.string().trim().min(1),
})
const userId = '33333333-3333-4333-8333-333333333333'

function run(middleware, req) {
  let continued = false

  try {
    middleware(req, {}, () => {
      continued = true
    })
  } catch (error) {
    return { continued, error }
  }

  return { continued }
}

describe('validateRequest', () => {
  it('accepts a valid body and keeps the parsed value', () => {
    const req = { body: { name: 'Ada' } }
    const result = run(validateRequest({ body: bodySchema }), req)

    assert.equal(result.continued, true)
    assert.deepEqual(req.validated.body, { name: 'Ada' })
  })

  it('returns 400 for an invalid body without revealing the submitted value', () => {
    const secret = 'super-secret-password'
    const req = { body: { name: secret } }
    const result = run(
      validateRequest({
        body: z.object({ name: z.string().min(80) }),
      }),
      req,
    )
    const published = JSON.stringify(result.error)

    assert.equal(result.continued, false)
    assert.equal(result.error.status, 400)
    assert.equal(result.error.code, 'VALIDATION_ERROR')
    assert.equal(result.error.message, 'Invalid request data')
    assert.equal(result.error.logMessage, 'request.validation')
    assert.equal(result.error.details[0].location, 'body')
    assert.equal(result.error.details[0].path, 'name')
    assert.equal(typeof result.error.details[0].code, 'string')
    assert.equal(published.includes(secret), false)
    assert.equal(req.validated, undefined)
  })

  it('accepts valid params', () => {
    const req = { params: { id: userId } }
    const result = run(validateRequest({ params: paramsSchema }), req)

    assert.equal(result.continued, true)
    assert.deepEqual(req.validated.params, { id: userId })
  })

  it('returns 400 for invalid params', () => {
    const result = run(validateRequest({ params: paramsSchema }), {
      params: { id: 'not-a-uuid' },
    })

    assert.equal(result.continued, false)
    assert.equal(result.error.status, 400)
    assert.equal(result.error.details[0].location, 'params')
    assert.equal(result.error.details[0].path, 'id')
    assert.equal(JSON.stringify(result.error).includes('not-a-uuid'), false)
  })

  it('accepts a valid query', () => {
    const req = { query: { q: 'lens' } }
    const result = run(validateRequest({ query: querySchema }), req)

    assert.equal(result.continued, true)
    assert.deepEqual(req.validated.query, { q: 'lens' })
  })

  it('returns 400 for an invalid query', () => {
    const result = run(validateRequest({ query: querySchema }), {
      query: { q: '   ' },
    })

    assert.equal(result.continued, false)
    assert.equal(result.error.status, 400)
    assert.equal(result.error.details[0].location, 'query')
    assert.equal(result.error.details[0].path, 'q')
  })

  it('validates body, params and query together', () => {
    const req = {
      body: { name: 'Ada' },
      params: { id: userId },
      query: { q: 'lens' },
    }
    const result = run(
      validateRequest({
        body: bodySchema,
        params: paramsSchema,
        query: querySchema,
      }),
      req,
    )

    assert.equal(result.continued, true)
    assert.deepEqual(req.validated, {
      body: { name: 'Ada' },
      params: { id: userId },
      query: { q: 'lens' },
    })
  })

  it('stores Zod transformations', () => {
    const req = { body: { name: '  Ada  ' } }
    const result = run(validateRequest({ body: bodySchema }), req)

    assert.equal(result.continued, true)
    assert.deepEqual(req.validated.body, { name: 'Ada' })
    assert.equal(req.body.name, '  Ada  ')
  })

  it('stores Zod defaults', () => {
    const req = { body: {} }
    const result = run(
      validateRequest({
        body: z.object({
          note: z.string().default('none'),
        }),
      }),
      req,
    )

    assert.equal(result.continued, true)
    assert.deepEqual(req.validated.body, { note: 'none' })
  })

  it('does not continue when validation fails', () => {
    const result = run(validateRequest({ body: bodySchema }), { body: {} })

    assert.equal(result.continued, false)
    assert.equal(result.error.status, 400)
  })

  it('keeps previously validated parts when a schema is omitted', () => {
    const req = {
      validated: {
        body: { name: 'kept' },
        params: { id: userId },
      },
      query: { q: 'lens' },
    }
    const result = run(validateRequest({ query: querySchema }), req)

    assert.equal(result.continued, true)
    assert.deepEqual(req.validated, {
      body: { name: 'kept' },
      params: { id: userId },
      query: { q: 'lens' },
    })
  })

  it('reports every invalid part in one response', () => {
    const result = run(
      validateRequest({
        body: bodySchema,
        query: querySchema,
      }),
      {
        body: {},
        query: {},
      },
    )
    const locations = result.error.details.map((detail) => detail.location)

    assert.equal(result.continued, false)
    assert.equal(locations.includes('body'), true)
    assert.equal(locations.includes('query'), true)
  })
})
