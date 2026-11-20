import { readCart } from './use-cart.js'
import { withGuestSession } from './use-guest-session.js'

export const CHECKOUT_STORAGE_KEY = 'shop_checkout_attempt'

const LIMITS = {
  email: 320,
  firstName: 100,
  lastName: 100,
  companyName: 200,
  phone: 32,
  recipient: 200,
  street: 200,
  buildingNumber: 20,
  apartmentNumber: 20,
  city: 100,
}

export function validateCheckoutForm(form) {
  const fields = {}
  const email = clean(form.email)
  const customerType = form.customerType
  const countryCode = clean(form.countryCode).toUpperCase()
  const postalCode = clean(form.postalCode)
  const street = clean(form.street)
  const buildingNumber = clean(form.buildingNumber)
  const city = clean(form.city)
  const firstName = clean(form.firstName)
  const lastName = clean(form.lastName)
  const companyName = clean(form.companyName)
  const nip = clean(form.nip)
  const phone = clean(form.phone)
  const recipient = clean(form.recipient)
  const apartmentNumber = clean(form.apartmentNumber)

  if (!email || email.length > LIMITS.email || !emailLooksValid(email)) {
    fields.email = 'Podaj prawidłowy e-mail.'
  }

  if (customerType !== 'individual' && customerType !== 'company') {
    fields.customerType = 'Wybierz osobę prywatną albo firmę.'
  }

  if (customerType === 'individual') {
    requireText(fields, 'firstName', firstName, LIMITS.firstName)
    requireText(fields, 'lastName', lastName, LIMITS.lastName)
  }

  if (customerType === 'company') {
    requireText(fields, 'companyName', companyName, LIMITS.companyName)

    if (!/^[0-9]{10}$/.test(nip)) {
      fields.nip = 'NIP musi mieć 10 cyfr.'
    }
  }

  requireText(fields, 'street', street, LIMITS.street)
  requireText(fields, 'buildingNumber', buildingNumber, LIMITS.buildingNumber)
  requireText(fields, 'city', city, LIMITS.city)

  if (!/^[0-9]{2}-[0-9]{3}$/.test(postalCode)) {
    fields.postalCode = 'Kod pocztowy musi mieć format NN-NNN.'
  }

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    fields.countryCode = 'Kod kraju musi mieć dwie wielkie litery.'
  }

  rejectOptional(fields, 'phone', phone, LIMITS.phone)
  rejectOptional(fields, 'recipient', recipient, LIMITS.recipient)
  rejectOptional(
    fields,
    'apartmentNumber',
    apartmentNumber,
    LIMITS.apartmentNumber,
  )

  if (customerType === 'individual' && nip && !/^[0-9]{10}$/.test(nip)) {
    fields.nip = 'NIP musi mieć 10 cyfr.'
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields }
  }

  const billing = {}
  const values = {
    apartmentNumber,
    buildingNumber,
    city,
    companyName,
    countryCode,
    firstName,
    lastName,
    nip,
    phone,
    postalCode,
    recipient,
    street,
  }

  for (const key of Object.keys(values).sort()) {
    if (values[key]) {
      billing[key] = values[key]
    }
  }

  return {
    ok: true,
    payload: {
      billing,
      customerType,
      email,
      paymentMethod: 'cash',
    },
  }
}

export function readCheckoutAttempt(storage) {
  const raw = storage.getItem(CHECKOUT_STORAGE_KEY)

  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)

    if (
      !parsed ||
      typeof parsed.key !== 'string' ||
      !parsed.payload ||
      typeof parsed.payload !== 'object'
    ) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export function clearCheckoutAttempt(storage) {
  storage.removeItem(CHECKOUT_STORAGE_KEY)
}

export function createIdempotencyKey() {
  return globalThis.crypto.randomUUID()
}

export function checkoutErrorMessage(code, status) {
  if (status === 0 || code === 'NETWORK_ERROR') {
    return 'Nie udało się połączyć ze sklepem. Możesz ponowić tę samą próbę. (NETWORK_ERROR)'
  }

  if (
    code === 'SELLER_TAX_STATUS_UNKNOWN' ||
    code === 'VAT_POLICY_NOT_CONFIRMED'
  ) {
    return `Sklep nie może obecnie przyjąć zamówienia. (${code})`
  }

  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    return 'Ta próba zamówienia ma już inne dane. Nie utworzono kolejnego zamówienia. (IDEMPOTENCY_KEY_REUSED)'
  }

  if (code === 'CART_CONVERTED') {
    return 'Koszyk został już zamieniony w zamówienie. (CART_CONVERTED)'
  }

  if (code === 'CHECKOUT_ATTEMPT_CHANGED') {
    return 'Dane formularza różnią się od rozpoczętej próby. Rozpocznij nową próbę, jeśli chcesz je wysłać. (CHECKOUT_ATTEMPT_CHANGED)'
  }

  if (code === 'CART_EMPTY') {
    return 'Koszyk jest pusty. (CART_EMPTY)'
  }

  if (code === 'CHECKOUT_IN_PROGRESS') {
    return 'Zamówienie jest już wysyłane. (CHECKOUT_IN_PROGRESS)'
  }

  return `Nie udało się złożyć zamówienia. (${code ?? 'REQUEST_FAILED'})`
}

export async function submitCheckout({
  request,
  loadCart,
  storage,
  form,
  gate,
  createKey = createIdempotencyKey,
}) {
  if (gate.current) {
    return { ok: false, code: 'CHECKOUT_IN_PROGRESS' }
  }

  gate.current = true

  try {
    const validation = validateCheckoutForm(form)

    if (!validation.ok) {
      return { ok: false, code: 'FORM_INVALID', fields: validation.fields }
    }

    const loaded = await loadCart()

    if (loaded.error) {
      return { ok: false, code: loaded.error.code, status: loaded.status }
    }

    const cart = readCart(loaded)

    if (!cart || cart.items.length === 0) {
      return { ok: false, code: 'CART_EMPTY' }
    }

    const stored = readCheckoutAttempt(storage)

    if (stored?.blocked === 'CART_CONVERTED') {
      return { ok: false, code: 'CART_CONVERTED', status: 409 }
    }

    if (stored && !samePayload(stored.payload, validation.payload)) {
      return { ok: false, code: 'CHECKOUT_ATTEMPT_CHANGED' }
    }

    const key = stored?.key ?? createKey()
    const payload = stored?.payload ?? validation.payload

    if (!stored) {
      writeAttempt(storage, { key, payload })
    }

    const result = await withGuestSession(request, () =>
      request('/checkout', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: payload,
      }),
    )

    if (!result.error && result.data?.data?.id) {
      clearCheckoutAttempt(storage)
      return { ok: true, orderId: result.data.data.id }
    }

    if (result.error?.code === 'CART_CONVERTED') {
      writeAttempt(storage, { key, payload, blocked: 'CART_CONVERTED' })
    }

    return {
      ok: false,
      code: result.error?.code ?? 'REQUEST_FAILED',
      status: result.status,
    }
  } finally {
    gate.current = false
  }
}

export function useCheckout() {
  const api = useApi()
  const gate = { current: false }

  return {
    submit(form) {
      return submitCheckout({
        request: api.request,
        loadCart() {
          return withGuestSession(api.request, () => api.request('/cart'))
        },
        storage: sessionStorage,
        form,
        gate,
      })
    },
    beginNewAttempt() {
      clearCheckoutAttempt(sessionStorage)
    },
  }
}

function writeAttempt(storage, attempt) {
  storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(attempt))
}

function samePayload(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requireText(fields, name, value, max) {
  if (!value || value.length > max) {
    fields[name] = 'To pole jest wymagane.'
  }
}

function rejectOptional(fields, name, value, max) {
  if (value.length > max) {
    fields[name] = 'To pole jest za długie.'
  }
}

function emailLooksValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
