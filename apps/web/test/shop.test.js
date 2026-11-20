import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  addCartItem,
  loadCart,
  readCart,
  removeCartItem,
  updateCartItem,
} from '../app/composables/use-cart.js'
import { loadCatalog, readList } from '../app/composables/use-catalog.js'
import {
  ensureGuestSession,
  resetGuestSession,
} from '../app/composables/use-guest-session.js'
import { formatAmount } from '../app/utils/money.js'

const sessionOk = {
  data: { data: { authenticated: false }, meta: {} },
  error: null,
  status: 200,
}

describe('guest shop', () => {
  beforeEach(() => {
    resetGuestSession()
  })

  it('starts one guest session for parallel callers and retries after failure', async () => {
    let calls = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const request = () => {
      calls += 1
      return gate
    }
    const first = ensureGuestSession(request)
    const second = ensureGuestSession(request)

    assert.equal(calls, 1)
    release(sessionOk)
    const [started, shared] = await Promise.all([first, second])

    assert.equal(started.status, 200)
    assert.equal(shared.data.data.authenticated, false)
    await ensureGuestSession(request)
    assert.equal(calls, 1)

    resetGuestSession()
    let attempts = 0
    const retrying = async () => {
      attempts += 1
      if (attempts === 1) {
        return {
          data: null,
          error: { code: 'NETWORK_ERROR', message: 'Network request failed' },
          status: 0,
        }
      }

      return sessionOk
    }

    const failed = await ensureGuestSession(retrying)
    const recovered = await ensureGuestSession(retrying)

    assert.equal(failed.error.code, 'NETWORK_ERROR')
    assert.equal(recovered.error, null)
    assert.equal(attempts, 2)
  })

  it('loads category and product lists, including an empty catalog', async () => {
    const calls = []
    const result = await loadCatalog((path) => {
      calls.push(path)
      const rows = path.startsWith('/categories')
        ? []
        : [{ id: 'p1', name: 'Session' }]
      return {
        data: { data: rows, meta: { page: 1, limit: 20, total: rows.length } },
        error: null,
        status: 200,
      }
    })

    assert.deepEqual(calls, [
      '/categories?page=1&limit=20',
      '/products?page=1&limit=20',
    ])
    assert.deepEqual(readList(result.categories), [])
    assert.equal(readList(result.products)[0].name, 'Session')
    assert.deepEqual(readList({ error: { code: 'REQUEST_FAILED' } }), [])
  })

  it('uses the guest cart endpoints and retries once after an unauthorized response', async () => {
    const calls = []
    const request = async (path, options = {}) => {
      calls.push({
        path,
        method: options.method ?? 'GET',
        body: options.body ?? null,
      })

      if (path === '/session/guest' && calls.length === 1) {
        return sessionOk
      }

      if (
        path === '/cart' &&
        calls.filter((call) => call.path === '/cart').length === 1
      ) {
        return {
          data: null,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          status: 401,
        }
      }

      return {
        data: {
          data: {
            currency: 'PLN',
            items: [],
            total_amount: 0,
          },
          meta: {},
        },
        error: null,
        status: 200,
      }
    }
    const loaded = await loadCart(request)

    assert.equal(loaded.error, null)
    assert.deepEqual(
      calls.map((call) => [call.path, call.method]),
      [
        ['/session/guest', 'POST'],
        ['/cart', 'GET'],
        ['/session/guest', 'POST'],
        ['/cart', 'GET'],
      ],
    )
    assert.deepEqual(readCart(loaded).items, [])

    resetGuestSession()
    calls.length = 0
    const productId = '44444444-4444-4444-8444-444444444444'
    const itemId = '66666666-6666-4666-8666-666666666666'
    const requestOk = async (path, options = {}) => {
      calls.push({
        path,
        method: options.method ?? 'GET',
        body: options.body ?? null,
      })
      return path === '/session/guest'
        ? sessionOk
        : {
            data: {
              data: {
                currency: 'PLN',
                items: [
                  {
                    id: itemId,
                    product_id: productId,
                    name: 'Session',
                    price_amount: 12900,
                    currency: 'PLN',
                    quantity: 2,
                    line_amount: 25800,
                  },
                ],
                total_amount: 25800,
              },
              meta: {},
            },
            error: null,
            status: 200,
          }
    }

    await addCartItem(requestOk, productId, 1)
    await updateCartItem(requestOk, itemId, 2)
    await removeCartItem(requestOk, itemId)

    assert.deepEqual(calls[1], {
      path: '/cart/items',
      method: 'POST',
      body: { productId, quantity: 1 },
    })
    assert.deepEqual(calls[2], {
      path: `/cart/items/${itemId}`,
      method: 'PATCH',
      body: { quantity: 2 },
    })
    assert.deepEqual(calls[3], {
      path: `/cart/items/${itemId}`,
      method: 'DELETE',
      body: null,
    })
    assert.equal(formatAmount(12900, 'PLN'), '129,00 PLN')
    assert.equal(formatAmount(25800, 'PLN'), '258,00 PLN')
  })
})
