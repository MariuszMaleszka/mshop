export function cartItemCount(cart) {
  if (!cart || !Array.isArray(cart.items)) {
    return null
  }

  return cart.items.reduce((sum, item) => {
    const quantity = item?.quantity

    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return sum
    }

    return sum + quantity
  }, 0)
}

let listener = null

export function onShopCartChange(callback) {
  listener = callback

  return () => {
    if (listener === callback) {
      listener = null
    }
  }
}

export function notifyShopCartChanged() {
  listener?.()
}
