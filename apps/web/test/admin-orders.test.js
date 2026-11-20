import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  fulfillmentStatusView,
  paymentStatusView,
} from '../app/modules/admin-orders/labels.js'
import {
  adminOrdersRequestPath,
  createAdminOrdersQuery,
  withAdminOrdersQuery,
} from '../app/modules/admin-orders/query.js'
import {
  readAdminOrder,
  readAdminOrders,
} from '../app/modules/admin-orders/view.js'
import { formatGrosze } from '../app/utils/money.js'

describe('admin orders', () => {
  it('formats whole grosze without a binary fraction', () => {
    assert.equal(formatGrosze('15900', 'PLN'), '159,00 PLN')
    assert.equal(formatGrosze('5', 'PLN'), '0,05 PLN')
    assert.equal(formatGrosze('-250', 'PLN'), '-2,50 PLN')
    assert.equal(formatGrosze('15.90', 'PLN'), null)
    assert.equal(formatGrosze('15900', 'pln'), null)
  })

  it('keeps an unknown status distinct from success', () => {
    assert.equal(paymentStatusView('paid').tone, 'success')
    assert.equal(paymentStatusView('mystery').label, 'Nierozpoznany')
    assert.equal(paymentStatusView('mystery').tone, 'danger')
    assert.equal(fulfillmentStatusView('completed').tone, 'success')
    assert.equal(fulfillmentStatusView('mystery').tone, 'danger')
    assert.notEqual(
      paymentStatusView('cancelled').label,
      fulfillmentStatusView('cancelled').label,
    )
  })

  it('resets the page when filters or sorting change', () => {
    const current = withAdminOrdersQuery(createAdminOrdersQuery(), {
      page: 4,
    })
    const filtered = withAdminOrdersQuery(
      current,
      { paymentStatus: 'pending', search: '  M2026  ' },
      { resetPage: true },
    )
    const sorted = withAdminOrdersQuery(
      filtered,
      { sortBy: 'orderNumber', sortOrder: 'asc' },
      { resetPage: true },
    )
    const paged = withAdminOrdersQuery(sorted, { page: 2, limit: 100 })

    assert.equal(filtered.page, 1)
    assert.equal(filtered.search, 'M2026')
    assert.equal(sorted.page, 1)
    assert.equal(sorted.sortBy, 'orderNumber')
    assert.equal(paged.page, 2)
    assert.equal(
      adminOrdersRequestPath(paged),
      'admin/orders?page=2&limit=100&sortBy=orderNumber&sortOrder=asc&search=M2026&paymentStatus=pending',
    )
    assert.equal(
      withAdminOrdersQuery(current, { sortBy: 'email', paymentMethod: 'card' })
        .sortBy,
      'createdAt',
    )
    assert.equal(
      withAdminOrdersQuery(current, { paymentMethod: 'card' }).paymentMethod,
      '',
    )
  })

  it('maps authorization and empty results without exposing the payload', () => {
    const meta = { page: 1, limit: 20, total: 0, totalPages: 0 }
    assert.equal(readAdminOrders({ status: 401 }, false).state, 'unauthorized')
    assert.equal(readAdminOrders({ status: 403 }, false).state, 'forbidden')
    assert.equal(
      readAdminOrders(
        { status: 503, error: { code: 'SERVICE_UNAVAILABLE', message: 'sql' } },
        false,
      ).state,
      'error',
    )
    assert.equal(
      readAdminOrders(
        { status: 200, data: { data: [], meta }, error: null },
        false,
      ).state,
      'empty',
    )
    assert.equal(
      readAdminOrders(
        { status: 200, data: { data: [], meta }, error: null },
        true,
      ).state,
      'filtered',
    )

    const ready = readAdminOrders(
      {
        status: 200,
        error: null,
        data: {
          data: [
            {
              id: '6f1c2a40-1c0e-4d0a-9a31-0b5e2f6a7c11',
              orderNumber: 'M1',
              createdAt: '2026-11-20T11:00:00.000Z',
              customer: { email: 'anna@example.com' },
              grossAmount: '15900',
              currency: 'PLN',
              paymentMethod: 'cash',
              paymentStatus: 'pending',
              fulfillmentStatus: 'new',
            },
          ],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      },
      false,
    )
    assert.equal(ready.state, 'ready')
    assert.equal(ready.rows[0].amount, '159,00 PLN')
    assert.equal(ready.rows[0].payment.label, 'Oczekuje')
    assert.equal(ready.rows[0].fulfillment.tone, 'info')
    assert.equal(
      readAdminOrder({
        status: 200,
        error: null,
        data: {
          data: {
            order: {
              id: '6f1c2a40-1c0e-4d0a-9a31-0b5e2f6a7c11',
              orderNumber: 'M1',
              createdAt: '2026-11-20T11:00:00.000Z',
              grossAmount: '15900',
              currency: 'PLN',
              paymentMethod: 'online',
              paymentStatus: 'pending',
              fulfillmentStatus: 'new',
            },
            customer: { email: 'anna@example.com' },
            payments: [
              { id: 'p1', status: 'pending', initializationStatus: 'unknown' },
            ],
          },
        },
      }).order.payments[0].initialization,
      'unknown',
    )
  })
})
