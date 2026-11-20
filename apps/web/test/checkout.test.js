import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  checkoutErrorMessage,
  clearCheckoutAttempt,
  submitCheckout,
  validateCheckoutForm,
} from '../app/composables/use-checkout.js'
import {
  displayAmount,
  orderErrorMessage,
} from '../app/composables/use-order.js'
import { resetGuestSession } from '../app/composables/use-guest-session.js'

const address = {
  street: 'Lipowa',
  buildingNumber: '1',
  postalCode: '00-001',
  city: 'Warszawa',
  countryCode: 'PL',
}

function individualForm(overrides = {}) {
  return {
    email: 'anna@example.com',
    customerType: 'individual',
    firstName: 'Anna',
    lastName: 'Nowak',
    companyName: '',
    nip: '',
    phone: '',
    recipient: '',
    apartmentNumber: '',
    ...address,
    ...overrides,
  }
}

function companyForm(overrides = {}) {
  return {
    email: 'firma@example.com',
    customerType: 'company',
    firstName: '',
    lastName: '',
    companyName: 'Nowak Sp. z o.o.',
    nip: '5555555555',
    phone: '',
    recipient: '',
    apartmentNumber: '',
    ...address,
    ...overrides,
  }
}

function memoryStorage() {
  const values = new Map()

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

function cartWithItem() {
  return {
    data: {
      data: {
        currency: 'PLN',
        total_amount: 4999,
        items: [{ id: 'item-1', quantity: 1 }],
      },
      meta: {},
    },
    error: null,
    status: 200,
  }
}

function sessionOk() {
  return {
    data: { data: { authenticated: false }, meta: {} },
    error: null,
    status: 200,
  }
}

describe('cash checkout', () => {
  beforeEach(() => {
    resetGuestSession()
  })

  it('rejects incomplete checkout data', () => {
    const result = validateCheckoutForm(
      individualForm({ email: 'zly', postalCode: '00001', countryCode: '1' }),
    )

    assert.equal(result.ok, false)
    assert.equal(typeof result.fields.email, 'string')
    assert.equal(typeof result.fields.postalCode, 'string')
    assert.equal(typeof result.fields.countryCode, 'string')
  })

  it('builds an individual payload and omits empty optional fields', () => {
    const result = validateCheckoutForm(individualForm({ phone: '   ' }))

    assert.equal(result.ok, true)
    assert.equal(result.payload.paymentMethod, 'cash')
    assert.equal(result.payload.customerType, 'individual')
    assert.deepEqual(result.payload.billing, {
      buildingNumber: '1',
      city: 'Warszawa',
      countryCode: 'PL',
      firstName: 'Anna',
      lastName: 'Nowak',
      postalCode: '00-001',
      street: 'Lipowa',
    })
    assert.equal(Object.hasOwn(result.payload.billing, 'phone'), false)
    assert.equal(Object.hasOwn(result.payload.billing, 'nip'), false)
  })

  it('builds a company payload with a ten-digit NIP', () => {
    const invalid = validateCheckoutForm(companyForm({ nip: '123' }))
    const result = validateCheckoutForm(
      companyForm({ phone: '500', apartmentNumber: '2' }),
    )

    assert.equal(invalid.ok, false)
    assert.equal(typeof invalid.fields.nip, 'string')
    assert.equal(result.ok, true)
    assert.equal(result.payload.billing.companyName, 'Nowak Sp. z o.o.')
    assert.equal(result.payload.billing.nip, '5555555555')
    assert.equal(result.payload.billing.phone, '500')
    assert.equal(result.payload.billing.apartmentNumber, '2')
    assert.equal(Object.hasOwn(result.payload.billing, 'firstName'), false)
  })

  it('does not call checkout for an empty cart', async () => {
    const calls = []
    const result = await submitCheckout({
      request(path) {
        calls.push(path)
        return sessionOk()
      },
      loadCart: async () => ({
        data: {
          data: { currency: 'PLN', total_amount: 0, items: [] },
          meta: {},
        },
        error: null,
        status: 200,
      }),
      storage: memoryStorage(),
      form: individualForm(),
      gate: { current: false },
    })

    assert.equal(result.code, 'CART_EMPTY')
    assert.deepEqual(calls, [])
  })

  it('blocks a second submit while the first request is running', async () => {
    let release
    const gate = { current: false }
    const request = async (path) => {
      if (path === '/session/guest') {
        return sessionOk()
      }

      return new Promise((resolve) => {
        release = resolve
      })
    }
    const input = {
      request,
      loadCart: async () => cartWithItem(),
      storage: memoryStorage(),
      form: individualForm(),
      gate,
      createKey: () => 'key-once',
    }
    const first = submitCheckout(input)

    for (let attempt = 0; attempt < 10 && !release; attempt += 1) {
      await Promise.resolve()
    }

    const second = await submitCheckout(input)

    assert.equal(second.code, 'CHECKOUT_IN_PROGRESS')
    release({
      data: { data: { id: '11111111-1111-4111-8111-111111111111' }, meta: {} },
      error: null,
      status: 201,
    })
    assert.equal((await first).ok, true)
  })

  it('repeats the same key and payload after a network error', async () => {
    const storage = memoryStorage()
    const checkouts = []
    const request = async (path, options) => {
      if (path === '/session/guest') {
        return sessionOk()
      }

      checkouts.push({
        key: options.headers['Idempotency-Key'],
        body: options.body,
      })
      return {
        data: null,
        error: { code: 'NETWORK_ERROR', message: 'Network request failed' },
        status: 0,
      }
    }
    const input = {
      request,
      loadCart: async () => cartWithItem(),
      storage,
      form: individualForm(),
      gate: { current: false },
      createKey: () => 'same-key',
    }

    const first = await submitCheckout(input)
    const second = await submitCheckout(input)

    assert.equal(first.status, 0)
    assert.equal(second.status, 0)
    assert.equal(checkouts.length, 2)
    assert.equal(checkouts[0].key, 'same-key')
    assert.deepEqual(checkouts[1], checkouts[0])
    assert.equal(
      JSON.parse(storage.getItem('shop_checkout_attempt')).key,
      'same-key',
    )
    assert.match(checkoutErrorMessage('NETWORK_ERROR', 0), /NETWORK_ERROR/)
    assert.match(
      checkoutErrorMessage('SELLER_TAX_STATUS_UNKNOWN', 409),
      /SELLER_TAX_STATUS_UNKNOWN/,
    )
    assert.match(
      checkoutErrorMessage('VAT_POLICY_NOT_CONFIRMED', 409),
      /VAT_POLICY_NOT_CONFIRMED/,
    )
  })

  it('does not create another order after the idempotency key was reused', async () => {
    const storage = memoryStorage()
    let keys = 0
    const request = async (path) => {
      if (path === '/session/guest') {
        return sessionOk()
      }

      return {
        data: null,
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was reused',
        },
        status: 409,
      }
    }
    const result = await submitCheckout({
      request,
      loadCart: async () => cartWithItem(),
      storage,
      form: individualForm(),
      gate: { current: false },
      createKey() {
        keys += 1
        return 'stored-key'
      },
    })
    const repeated = await submitCheckout({
      request,
      loadCart: async () => cartWithItem(),
      storage,
      form: individualForm(),
      gate: { current: false },
      createKey() {
        keys += 1
        return 'new-key'
      },
    })

    assert.equal(result.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(repeated.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(keys, 1)
    assert.equal(
      JSON.parse(storage.getItem('shop_checkout_attempt')).key,
      'stored-key',
    )
  })

  it('clears the attempt after success and does not retry a converted cart', async () => {
    const storage = memoryStorage()
    const calls = []
    const request = async (path) => {
      calls.push(path)

      if (path === '/session/guest') {
        return sessionOk()
      }

      if (calls.filter((item) => item === '/checkout').length === 1) {
        return {
          data: {
            data: { id: '22222222-2222-4222-8222-222222222222' },
            meta: {},
          },
          error: null,
          status: 201,
        }
      }

      return {
        data: null,
        error: { code: 'CART_CONVERTED', message: 'Cart is already converted' },
        status: 409,
      }
    }
    const success = await submitCheckout({
      request,
      loadCart: async () => cartWithItem(),
      storage,
      form: individualForm(),
      gate: { current: false },
      createKey: () => 'success-key',
    })

    assert.equal(success.ok, true)
    assert.equal(storage.getItem('shop_checkout_attempt'), null)

    const converted = await submitCheckout({
      async request() {
        calls.push('/checkout-again')
        return {
          data: null,
          error: {
            code: 'CART_CONVERTED',
            message: 'Cart is already converted',
          },
          status: 409,
        }
      },
      loadCart: async () => cartWithItem(),
      storage,
      form: individualForm(),
      gate: { current: false },
      createKey: () => 'converted-key',
    })
    clearCheckoutAttempt(storage)
    const stored = {
      key: 'converted-key',
      payload: validateCheckoutForm(individualForm()).payload,
      blocked: 'CART_CONVERTED',
    }
    storage.setItem('shop_checkout_attempt', JSON.stringify(stored))
    const blockedCalls = []
    const blocked = await submitCheckout({
      async request(path) {
        blockedCalls.push(path)
        return sessionOk()
      },
      loadCart: async () => cartWithItem(),
      storage,
      form: individualForm(),
      gate: { current: false },
      createKey: () => 'should-not-run',
    })

    assert.equal(converted.code, 'CART_CONVERTED')
    assert.equal(blocked.code, 'CART_CONVERTED')
    assert.deepEqual(blockedCalls, [])
  })
})

describe('order display', () => {
  it('formats API grosze and hides whether a missing order exists', () => {
    assert.equal(displayAmount('4999', 'PLN'), '49,99 PLN')
    assert.equal(displayAmount('0', 'PLN'), '0,00 PLN')
    assert.equal(
      orderErrorMessage({ error: { code: 'NOT_FOUND' }, status: 404 }),
      orderErrorMessage({ error: { code: 'NOT_FOUND' }, status: 404 }),
    )
    assert.match(
      orderErrorMessage({ error: { code: 'UNAUTHORIZED' }, status: 401 }),
      /UNAUTHORIZED/,
    )
  })
})
