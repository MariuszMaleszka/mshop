import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OrdersPage from '../../app/pages/admin/orders.vue'
import {
  assertBffCall,
  assertMountedLoad,
  assertNoSecrets,
  installFetch,
  jsonResponse,
  mountAdminPage,
  settle,
  withSecrets,
} from './admin-page-harness.js'

const LIST_URL =
  'http://localhost:3000/api/v1/admin/orders?page=1&limit=20&sortBy=createdAt&sortOrder=desc'
const LOGIN_MESSAGE =
  'Panel wymaga zalogowania administratora. Logowanie nie jest jeszcze podłączone.'
const FORBIDDEN_MESSAGE = 'To konto nie ma uprawnień administratora.'
const ERROR_MESSAGE = 'Nie udało się pobrać zamówień.'

describe('admin orders page', () => {
  const wrappers = []

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const wrapper of wrappers.splice(0)) {
      wrapper.unmount()
    }
  })

  it('compiles and sets up the real page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: false,
          status: 503,
          async text() {
            return ''
          },
        }
      }),
    )

    const wrapper = await mountSuspended(OrdersPage)
    wrappers.push(wrapper)

    expect(wrapper.get('h1').text()).toBe('Zamówienia')
  })

  it('shows loading before the mounted request resolves', async () => {
    const pending = installFetch(jsonResponse(200, listBody()), { defer: true })
    const wrapper = await mountPage()
    wrappers.push(wrapper)

    expect(wrapper.text()).toContain('Ładowanie zamówień.')
    expect(pending.calls).toHaveLength(1)
    assertBffCall(pending.calls[0], LIST_URL)
    assertMountedLoad(pending.calls[0], 'app/pages/admin/orders.vue')
    assertNoSecrets(wrapper)
    pending.release()
    await settle()
  })

  it('shows the orders returned by the BFF', async () => {
    const pending = installFetch(jsonResponse(200, listBody()))
    const wrapper = await mountPage()
    wrappers.push(wrapper)
    await settle()

    expect(pending.calls).toHaveLength(1)
    assertBffCall(pending.calls[0], LIST_URL)
    assertMountedLoad(pending.calls[0], 'app/pages/admin/orders.vue')
    expect(wrapper.text()).toContain('M-100')
    expect(wrapper.text()).toContain('customer@example.com')
    expect(wrapper.text()).toContain('129,00 PLN')
    expect(wrapper.text()).not.toContain('Ładowanie zamówień.')
    assertNoSecrets(wrapper)
  })

  it('shows the login message after HTTP 401', async () => {
    await expectStatus(401, LOGIN_MESSAGE)
  })

  it('shows the permission message after HTTP 403', async () => {
    await expectStatus(403, FORBIDDEN_MESSAGE)
  })

  it('shows the read failure after HTTP 503', async () => {
    await expectStatus(503, ERROR_MESSAGE)
  })

  async function expectStatus(status, message) {
    const pending = installFetch(
      jsonResponse(
        status,
        withSecrets({ error: { code: 'HTTP', message: 'upstream' } }),
      ),
    )
    const wrapper = await mountPage()
    wrappers.push(wrapper)
    await settle()

    expect(pending.calls).toHaveLength(1)
    assertBffCall(pending.calls[0], LIST_URL)
    assertMountedLoad(pending.calls[0], 'app/pages/admin/orders.vue')
    expect(wrapper.text()).toContain(message)
    expect(wrapper.text()).not.toContain('M-100')
    expect(wrapper.text()).not.toContain('upstream')
    assertNoSecrets(wrapper)
  }
})

function mountPage() {
  return mountAdminPage(OrdersPage, { route: '/admin/orders' })
}

function listBody() {
  return withSecrets({
    data: [
      {
        id: '6f1c2a40-1c0e-4d0a-9a31-0b5e2f6a7c11',
        orderNumber: 'M-100',
        createdAt: '2026-11-24T08:00:00.000Z',
        customer: { email: 'customer@example.com' },
        grossAmount: '12900',
        currency: 'PLN',
        paymentMethod: 'cash',
        paymentStatus: 'pending',
        fulfillmentStatus: 'new',
      },
    ],
    meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
  })
}
