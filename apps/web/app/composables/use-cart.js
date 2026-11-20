import { withGuestSession } from './use-guest-session.js'

export function loadCart(request) {
  return withGuestSession(request, () => request('/cart'))
}

export function addCartItem(request, productId, quantity) {
  return withGuestSession(request, () =>
    request('/cart/items', {
      method: 'POST',
      body: { productId, quantity },
    }),
  )
}

export function updateCartItem(request, itemId, quantity) {
  return withGuestSession(request, () =>
    request(`/cart/items/${itemId}`, {
      method: 'PATCH',
      body: { quantity },
    }),
  )
}

export function removeCartItem(request, itemId) {
  return withGuestSession(request, () =>
    request(`/cart/items/${itemId}`, { method: 'DELETE' }),
  )
}

export function readCart(result) {
  const cart = result?.data?.data

  if (!cart || !Array.isArray(cart.items)) {
    return null
  }

  return cart
}

export function useCart() {
  const api = useApi()

  return {
    load() {
      return loadCart(api.request)
    },
    add(productId, quantity) {
      return addCartItem(api.request, productId, quantity)
    },
    update(itemId, quantity) {
      return updateCartItem(api.request, itemId, quantity)
    },
    remove(itemId) {
      return removeCartItem(api.request, itemId)
    },
  }
}
