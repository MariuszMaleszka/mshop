import { afterEach, describe, expect, it, vi } from 'vitest'
import OrderPage from '../../app/pages/admin/orders/[id].vue'
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

const ORDER_ID = '6f1c2a40-1c0e-4d0a-9a31-0b5e2f6a7c11'
const INVALID_ID = '6f1c2a40-1c0e-0d0a-9a31-0b5e2f6a7c11'
const DETAIL_URL = `http://localhost:3000/api/v1/admin/orders/${ORDER_ID}`
const LOGIN_MESSAGE =
  'Panel wymaga zalogowania administratora. Logowanie nie jest jeszcze podłączone.'
const FORBIDDEN_MESSAGE = 'To konto nie ma uprawnień administratora.'
const MISSING_MESSAGE = 'Nie znaleziono zamówienia.'
const ERROR_MESSAGE = 'Nie udało się pobrać zamówienia.'

describe('admin order detail page', () => {
  const wrappers = []

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const wrapper of wrappers.splice(0)) {
      wrapper.unmount()
    }
  })

  it('shows loading before the mounted request resolves', async () => {
    const pending = installFetch(jsonResponse(200, detailBody()), {
      defer: true,
    })
    const wrapper = await mountPage(ORDER_ID)
    wrappers.push(wrapper)

    expect(wrapper.text()).toContain('Ładowanie zamówienia.')
    expect(pending.calls).toHaveLength(1)
    assertBffCall(pending.calls[0], DETAIL_URL)
    assertMountedLoad(pending.calls[0], 'app/pages/admin/orders/[id].vue')
    assertNoSecrets(wrapper)
    pending.release()
    await settle()
  })

  it('shows the order returned by the BFF', async () => {
    const pending = installFetch(jsonResponse(200, detailBody()))
    const wrapper = await mountPage(ORDER_ID)
    wrappers.push(wrapper)
    await settle()

    expect(pending.calls).toHaveLength(1)
    assertBffCall(pending.calls[0], DETAIL_URL)
    assertMountedLoad(pending.calls[0], 'app/pages/admin/orders/[id].vue')
    expect(wrapper.text()).toContain('M-200')
    expect(wrapper.text()).toContain('buyer@example.com')
    expect(wrapper.text()).toContain('25,00 PLN')
    expect(wrapper.text()).not.toContain('Ładowanie zamówienia.')
    assertNoSecrets(wrapper)
  })

  it('shows the login message after HTTP 401', async () => {
    await expectStatus(401, LOGIN_MESSAGE)
  })

  it('shows the permission message after HTTP 403', async () => {
    await expectStatus(403, FORBIDDEN_MESSAGE)
  })

  it('shows the missing message after HTTP 404', async () => {
    await expectStatus(404, MISSING_MESSAGE)
  })

  it('shows the read failure after HTTP 503', async () => {
    await expectStatus(503, ERROR_MESSAGE)
  })

  it('rejects an invalid id without calling the BFF', async () => {
    const pending = installFetch(jsonResponse(200, detailBody()))
    const wrapper = await mountPage(INVALID_ID)
    wrappers.push(wrapper)
    await settle()

    expect(pending.calls).toHaveLength(0)
    expect(wrapper.text()).toContain(MISSING_MESSAGE)
    expect(wrapper.text()).not.toContain('M-200')
    assertNoSecrets(wrapper)
  })

  async function expectStatus(status, message) {
    const pending = installFetch(
      jsonResponse(
        status,
        withSecrets({ error: { code: 'HTTP', message: 'upstream' } }),
      ),
    )
    const wrapper = await mountPage(ORDER_ID)
    wrappers.push(wrapper)
    await settle()

    expect(pending.calls).toHaveLength(1)
    assertBffCall(pending.calls[0], DETAIL_URL)
    assertMountedLoad(pending.calls[0], 'app/pages/admin/orders/[id].vue')
    expect(wrapper.text()).toContain(message)
    expect(wrapper.text()).not.toContain('M-200')
    expect(wrapper.text()).not.toContain('upstream')
    assertNoSecrets(wrapper)
  }
})

function mountPage(id) {
  return mountAdminPage(OrderPage, { route: `/admin/orders/${id}` })
}

function detailBody() {
  return withSecrets({
    data: {
      order: {
        id: ORDER_ID,
        orderNumber: 'M-200',
        createdAt: '2026-11-24T08:00:00.000Z',
        grossAmount: '2500',
        currency: 'PLN',
        paymentMethod: 'cash',
        paymentStatus: 'paid',
        fulfillmentStatus: 'new',
      },
      customer: { email: 'buyer@example.com' },
      payments: [],
    },
    meta: {},
  })
}
