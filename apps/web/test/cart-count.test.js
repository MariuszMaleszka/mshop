import assert from 'node:assert/strict'
import test from 'node:test'
import { cartItemCount } from '../app/components/shop/cart-count.js'

test('sums only safe positive quantities', () => {
  assert.equal(
    cartItemCount({
      items: [
        { quantity: 2 },
        { quantity: 1 },
        { quantity: 0 },
        { quantity: 1.5 },
      ],
    }),
    3,
  )
})

test('returns null when the cart cannot be read', () => {
  assert.equal(cartItemCount(null), null)
  assert.equal(cartItemCount({ items: 'no' }), null)
})
