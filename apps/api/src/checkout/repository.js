const SELLER_SQL = `
  SELECT seller_tax_status
  FROM public.shop_profile
  WHERE id = true
`

const GUEST_CARTS_SQL = `
  SELECT id, status
  FROM public.carts
  WHERE session_id = $1
    AND user_id IS NULL
    AND status IN ('active', 'converted')
`

const ACCOUNT_CARTS_SQL = `
  SELECT id, status
  FROM public.carts
  WHERE user_id = $1::uuid
    AND session_id IS NULL
    AND status IN ('active', 'converted')
`

const ITEMS_SQL = `
  SELECT ci.product_id, p.is_active
  FROM public.cart_items AS ci
  LEFT JOIN public.products AS p ON p.id = ci.product_id
  WHERE ci.cart_id = $1::uuid
`

export async function readCheckoutPreconditions(database, owner) {
  const seller = await database.query(SELLER_SQL)
  const sellerStatus = seller.rows[0]?.seller_tax_status

  if (seller.rows.length !== 1) {
    throw new Error('Shop profile is missing')
  }

  if (sellerStatus === 'unknown') {
    return { outcome: 'seller_unknown' }
  }

  if (sellerStatus !== 'registered' && sellerStatus !== 'exempt') {
    throw new Error('Shop profile status is invalid')
  }

  const carts = await database.query(
    owner.kind === 'account' ? ACCOUNT_CARTS_SQL : GUEST_CARTS_SQL,
    [owner.key],
  )
  const active = carts.rows.find((cart) => cart.status === 'active')

  if (!active) {
    return {
      outcome: carts.rows.some((cart) => cart.status === 'converted')
        ? 'converted'
        : 'missing',
    }
  }

  const items = await database.query(ITEMS_SQL, [active.id])

  if (items.rows.length === 0) {
    return { outcome: 'empty' }
  }

  if (items.rows.some((item) => item.is_active !== true)) {
    return { outcome: 'inactive' }
  }

  return { outcome: 'ready' }
}
