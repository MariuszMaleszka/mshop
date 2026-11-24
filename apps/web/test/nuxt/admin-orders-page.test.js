import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'
import OrdersPage from '../../app/pages/admin/orders.vue'

describe('admin orders page', () => {
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

    expect(wrapper.get('h1').text()).toBe('Zamówienia')
  })
})
