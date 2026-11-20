import { withGuestSession } from './use-guest-session.js'
import { formatAmount } from '../utils/money.js'

export function loadOrder(request, orderId) {
  return withGuestSession(request, () => request(`/orders/${orderId}`))
}

export function readOrder(result) {
  const order = result?.data?.data

  if (!order || !Array.isArray(order.items)) {
    return null
  }

  return order
}

export function displayAmount(value, currency) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null
  }

  const amount = Number(value)

  if (!Number.isSafeInteger(amount)) {
    return null
  }

  return formatAmount(amount, currency)
}

export function orderErrorMessage(result) {
  const code = result.error?.code ?? 'REQUEST_FAILED'

  if (result.status === 401 || code === 'UNAUTHORIZED') {
    return 'Brak sesji. Nie można odczytać zamówienia. (UNAUTHORIZED)'
  }

  if (result.status === 404 || code === 'NOT_FOUND') {
    return 'Zamówienie jest niedostępne. (NOT_FOUND)'
  }

  return `Nie udało się odczytać zamówienia. (${code})`
}

export function useOrder() {
  const api = useApi()

  return {
    load(orderId) {
      return loadOrder(api.request, orderId)
    },
  }
}
