import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requestAdminOrders } from '../app/modules/admin-orders/bff.js'
import { adminOrdersRequestPath } from '../app/modules/admin-orders/query.js'
import {
  readAdminOrder,
  readAdminOrders,
} from '../app/modules/admin-orders/view.js'

const origin = 'http://127.0.0.1:3000'
const orderId = '6f1c2a40-1c0e-4d0a-9a31-0b5e2f6a7c11'

function fetchFor(status, body) {
  const calls = []
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url: String(url), options })
      if (body instanceof Error) {
        throw body
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
          return JSON.stringify(body)
        },
      }
    },
  }
}

describe('admin orders BFF client', () => {
  it('requests the Nuxt list and detail paths with the session cookie', async () => {
    const listPath = adminOrdersRequestPath({
      page: 2,
      limit: 20,
      sortBy: 'orderNumber',
      sortOrder: 'asc',
      search: 'M2026',
      paymentStatus: 'pending',
      fulfillmentStatus: '',
      paymentMethod: '',
    })
    const list = fetchFor(200, {
      data: [],
      meta: { page: 2, limit: 20, total: 0, totalPages: 0 },
    })
    const detail = fetchFor(200, {
      data: {
        order: {
          id: orderId,
          orderNumber: 'M1',
          createdAt: '2026-11-20T11:00:00.000Z',
          grossAmount: '15900',
          currency: 'PLN',
          paymentMethod: 'cash',
          paymentStatus: 'pending',
          fulfillmentStatus: 'new',
        },
        customer: { email: 'anna@example.com' },
        payments: [],
      },
      meta: {},
    })

    const listResult = await requestAdminOrders(origin, listPath, list)
    const detailResult = await requestAdminOrders(
      origin,
      `admin/orders/${orderId}`,
      detail,
    )

    assert.equal(list.calls[0].url, `http://127.0.0.1:3000/api/v1/${listPath}`)
    assert.equal(
      detail.calls[0].url,
      `http://127.0.0.1:3000/api/v1/admin/orders/${orderId}`,
    )
    assert.equal(list.calls[0].options.credentials, 'include')
    assert.equal(detail.calls[0].options.credentials, 'include')
    assert.equal(list.calls[0].options.headers.has('authorization'), false)
    assert.equal(
      list.calls[0].options.headers.has('x-mshop-internal-secret'),
      false,
    )
    assert.equal(list.calls[0].options.headers.has('x-mshop-client-ip'), false)
    assert.equal(listResult.error, null)
    assert.equal(listResult.status, 200)
    assert.equal(readAdminOrders(listResult, true).state, 'filtered')
    assert.equal(detailResult.error, null)
    assert.equal(detailResult.status, 200)
    assert.equal(readAdminOrder(detailResult).state, 'ready')
  })

  it('keeps HTTP statuses and hides a network failure', async () => {
    const cases = [
      [401, 'UNAUTHORIZED', 'unauthorized'],
      [403, 'FORBIDDEN', 'forbidden'],
      [404, 'NOT_FOUND', 'missing'],
      [503, 'SERVICE_UNAVAILABLE', 'error'],
    ]

    for (const [status, code, state] of cases) {
      const transport = fetchFor(status, {
        error: { code, message: 'Safe message', details: [] },
      })
      const result = await requestAdminOrders(
        origin,
        `admin/orders/${orderId}`,
        transport,
      )

      assert.equal(result.status, status)
      assert.equal(result.data, null)
      assert.deepEqual(result.error, { code, message: 'Safe message' })
      assert.equal(readAdminOrder(result).state, state)
      assert.equal(transport.calls[0].options.credentials, 'include')
    }

    const failed = fetchFor(0, new Error('network down'))
    const network = await requestAdminOrders(origin, 'admin/orders', failed)

    assert.equal(network.status, 0)
    assert.equal(network.data, null)
    assert.equal(network.error.code, 'NETWORK_ERROR')
    assert.equal(readAdminOrders(network, false).state, 'error')
  })
})
