import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { paginationOffset, paginationQuerySchema } from '../src/http/pagination.js'

function parse(query) {
  return paginationQuerySchema.safeParse(query)
}

describe('pagination', () => {
  it('defaults page to 1 and limit to 20', () => {
    const result = parse({})

    assert.equal(result.success, true)
    assert.equal(result.data.page, 1)
    assert.equal(result.data.limit, 20)
    assert.equal(result.data.offset, 0)
  })

  it('accepts a limit of 100', () => {
    const result = parse({ page: '1', limit: '100' })

    assert.equal(result.success, true)
    assert.deepEqual(result.data, { page: 1, limit: 100, offset: 0 })
  })

  it('rejects a limit above 100', () => {
    const result = parse({ page: '1', limit: '101' })

    assert.equal(result.success, false)
    assert.equal(result.error.issues[0].path[0], 'limit')
  })

  it('rejects negative page and limit', () => {
    assert.equal(parse({ page: '-1', limit: '20' }).success, false)
    assert.equal(parse({ page: '1', limit: '-5' }).success, false)
  })

  it('rejects zero', () => {
    assert.equal(parse({ page: '0', limit: '20' }).success, false)
    assert.equal(parse({ page: '1', limit: '0' }).success, false)
  })

  it('rejects fractional numbers', () => {
    assert.equal(parse({ page: '1.5', limit: '20' }).success, false)
    assert.equal(parse({ page: '2', limit: '20.2' }).success, false)
  })

  it('rejects text that is not an integer', () => {
    assert.equal(parse({ page: 'two', limit: '20' }).success, false)
    assert.equal(parse({ page: '1', limit: 'many' }).success, false)
  })

  it('calculates the offset from page and limit', () => {
    const result = parse({ page: '4', limit: '25' })

    assert.equal(result.success, true)
    assert.deepEqual(result.data, { page: 4, limit: 25, offset: 75 })
    assert.equal(paginationOffset(4, 25), 75)
    assert.equal(paginationOffset(1, 20), 0)
  })

  it('rejects an offset that is not a safe integer', () => {
    assert.throws(() => paginationOffset(Number.MAX_SAFE_INTEGER, 100), TypeError)
    assert.equal(
      parse({ page: String(Number.MAX_SAFE_INTEGER), limit: '100' }).success,
      false,
    )
  })
})
