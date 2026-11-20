import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PREVIEW_ORDERS } from '../app/modules/orders-preview/records.js'
import {
  applyOrdersQuery,
  normalizeOrdersQuery,
} from '../app/modules/orders-preview/query.js'

const base = {
  page: 1,
  limit: 10,
  sortField: 'createdAt',
  sortOrder: 'desc',
  search: '',
  fulfillmentStatus: null,
  paymentStatus: null,
  dateFrom: null,
  dateTo: null,
}

describe('orders preview query', () => {
  it('rejects a sort field outside the whitelist', () => {
    const result = normalizeOrdersQuery({ ...base, sortField: 'email' })

    assert.equal(result.ok, false)
    assert.equal(result.errors.includes('sortField'), true)
  })

  it('returns one server page and the filtered total', () => {
    const normalized = normalizeOrdersQuery({
      ...base,
      limit: 2,
      paymentStatus: 'paid',
      sortField: 'orderNumber',
      sortOrder: 'asc',
    })
    const page = applyOrdersQuery(PREVIEW_ORDERS, normalized.query)

    assert.equal(page.total, 4)
    assert.equal(page.records.length, 2)
    assert.equal(page.records[0].orderNumber, 'C1002')
  })

  it('filters by search and date without keeping other rows', () => {
    const normalized = normalizeOrdersQuery({
      ...base,
      search: 'anna',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-01',
    })
    const page = applyOrdersQuery(PREVIEW_ORDERS, normalized.query)

    assert.equal(page.total, 1)
    assert.equal(page.records[0].customerName, 'Anna Nowak')
  })
})
