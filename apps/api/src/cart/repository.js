const MAX_SAFE_AMOUNT = 9007199254740991n
const MAX_QUANTITY = 2147483647n
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
export const GUEST_CART_LOCK_NAMESPACE = 71001
export const ACCOUNT_CART_LOCK_NAMESPACE = 71002

const LOCK_OWNER_SQL = `
  SELECT pg_advisory_xact_lock($1::integer, $2::integer)
`

const PRODUCT_SQL = `
  SELECT id, is_active, btrim(currency) AS currency, price_amount
  FROM public.products
  WHERE id = $1::uuid
`

const INSERT_CART_SQL = `
  INSERT INTO public.carts (session_id, currency)
  VALUES ($1, 'PLN')
  ON CONFLICT (session_id)
    WHERE status = 'active' AND session_id IS NOT NULL
  DO NOTHING
`

const LOCK_CART_SQL = `
  SELECT id
  FROM public.carts
  WHERE session_id = $1
    AND user_id IS NULL
    AND status = 'active'
  FOR UPDATE
`

const LINES_SQL = `
  SELECT
    ci.product_id,
    ci.quantity,
    p.price_amount,
    btrim(p.currency) AS currency
  FROM public.cart_items AS ci
  JOIN public.products AS p ON p.id = ci.product_id
  WHERE ci.cart_id = $1::uuid
`

const UPSERT_ITEM_SQL = `
  INSERT INTO public.cart_items (cart_id, product_id, quantity)
  VALUES ($1::uuid, $2::uuid, $3::integer)
  ON CONFLICT (cart_id, product_id)
  DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
  WHERE cart_items.quantity <= 2147483647 - EXCLUDED.quantity
  RETURNING cart_items.id
`

const LOCK_ITEM_SQL = `
  SELECT ci.cart_id, ci.product_id
  FROM public.cart_items AS ci
  JOIN public.carts AS c ON c.id = ci.cart_id
  WHERE ci.id = $1::uuid
    AND c.session_id = $2
    AND c.user_id IS NULL
    AND c.status = 'active'
  FOR UPDATE OF c
`

const UPDATE_ITEM_SQL = `
  UPDATE public.cart_items AS ci
  SET quantity = $3::integer
  FROM public.carts AS c
  WHERE ci.id = $1::uuid
    AND ci.cart_id = c.id
    AND c.session_id = $2
    AND c.user_id IS NULL
    AND c.status = 'active'
  RETURNING ci.id
`

const DELETE_ITEM_SQL = `
  DELETE FROM public.cart_items AS ci
  USING public.carts AS c
  WHERE ci.id = $1::uuid
    AND ci.cart_id = c.id
    AND c.session_id = $2
    AND c.user_id IS NULL
    AND c.status = 'active'
  RETURNING ci.id
`

const CART_SQL = `
  SELECT
    ci.id,
    ci.product_id,
    p.name,
    p.price_amount,
    btrim(p.currency) AS currency,
    ci.quantity
  FROM public.cart_items AS ci
  JOIN public.carts AS c ON c.id = ci.cart_id
  JOIN public.products AS p ON p.id = ci.product_id
  WHERE c.session_id = $1
    AND c.user_id IS NULL
    AND c.status = 'active'
  ORDER BY ci.created_at ASC, ci.id ASC
`

const INSERT_ACCOUNT_CART_SQL = `
  INSERT INTO public.carts (user_id, currency)
  VALUES ($1::uuid, 'PLN')
  ON CONFLICT (user_id)
    WHERE status = 'active' AND user_id IS NOT NULL
  DO NOTHING
`

const LOCK_ACCOUNT_CART_SQL = `
  SELECT id
  FROM public.carts
  WHERE user_id = $1::uuid
    AND session_id IS NULL
    AND status = 'active'
  FOR UPDATE
`

const LOCK_ACCOUNT_ITEM_SQL = `
  SELECT ci.cart_id, ci.product_id
  FROM public.cart_items AS ci
  JOIN public.carts AS c ON c.id = ci.cart_id
  WHERE ci.id = $1::uuid
    AND c.user_id = $2::uuid
    AND c.session_id IS NULL
    AND c.status = 'active'
  FOR UPDATE OF c
`

const UPDATE_ACCOUNT_ITEM_SQL = `
  UPDATE public.cart_items AS ci
  SET quantity = $3::integer
  FROM public.carts AS c
  WHERE ci.id = $1::uuid
    AND ci.cart_id = c.id
    AND c.user_id = $2::uuid
    AND c.session_id IS NULL
    AND c.status = 'active'
  RETURNING ci.id
`

const DELETE_ACCOUNT_ITEM_SQL = `
  DELETE FROM public.cart_items AS ci
  USING public.carts AS c
  WHERE ci.id = $1::uuid
    AND ci.cart_id = c.id
    AND c.user_id = $2::uuid
    AND c.session_id IS NULL
    AND c.status = 'active'
  RETURNING ci.id
`

const LOCK_GUEST_CART_MERGE_SQL = `
  SELECT id, btrim(currency) AS currency
  FROM public.carts
  WHERE session_id = $1
    AND user_id IS NULL
    AND status = 'active'
  FOR UPDATE
`

const LOCK_ACCOUNT_CART_MERGE_SQL = `
  SELECT id, btrim(currency) AS currency
  FROM public.carts
  WHERE user_id = $1::uuid
    AND session_id IS NULL
    AND status = 'active'
  FOR UPDATE
`

const LOCK_MERGE_LINES_SQL = `
  SELECT
    ci.id,
    ci.product_id,
    ci.quantity,
    p.price_amount,
    btrim(p.currency) AS currency
  FROM public.cart_items AS ci
  JOIN public.products AS p ON p.id = ci.product_id
  WHERE ci.cart_id = $1::uuid
  ORDER BY ci.created_at ASC, ci.id ASC
  FOR UPDATE OF ci
`

const ADOPT_GUEST_CART_SQL = `
  UPDATE public.carts
  SET user_id = $1::uuid,
      session_id = NULL
  WHERE id = $2::uuid
    AND session_id = $3
    AND user_id IS NULL
    AND status = 'active'
  RETURNING id
`

const ABANDON_GUEST_CART_SQL = `
  UPDATE public.carts
  SET status = 'abandoned'
  WHERE id = $1::uuid
    AND session_id = $2
    AND user_id IS NULL
    AND status = 'active'
  RETURNING id
`

const ACCOUNT_CART_SQL = `
  SELECT
    ci.id,
    ci.product_id,
    p.name,
    p.price_amount,
    btrim(p.currency) AS currency,
    ci.quantity
  FROM public.cart_items AS ci
  JOIN public.carts AS c ON c.id = ci.cart_id
  JOIN public.products AS p ON p.id = ci.product_id
  WHERE c.user_id = $1::uuid
    AND c.session_id IS NULL
    AND c.status = 'active'
  ORDER BY ci.created_at ASC, ci.id ASC
`

export class CartAmountError extends Error {
  constructor() {
    super('Cart amount exceeds the supported range')
    this.name = 'CartAmountError'
  }
}

export class CartMergeError extends Error {
  constructor(reason) {
    super('Cart merge rejected')
    this.name = 'CartMergeError'
    this.reason = reason
  }
}

export function guestCartLockKey(sessionHash) {
  return lockKeyFromHex(sessionHash)
}

export function accountCartLockKey(userId) {
  if (typeof userId !== 'string') {
    throw new TypeError('Invalid cart owner key')
  }

  return lockKeyFromHex(userId.replaceAll('-', ''))
}

export async function findGuestCart(database, sessionHash) {
  const result = await database.query(CART_SQL, [sessionHash])
  return presentCart(result.rows)
}

export async function addGuestCartItem(
  database,
  sessionHash,
  { productId, quantity },
) {
  return database.withTransaction(async (tx) => {
    await lockGuestCart(tx, sessionHash)
    return addItem(tx, sessionHash, productId, quantity)
  })
}

export async function updateGuestCartItem(
  database,
  sessionHash,
  { itemId, quantity },
) {
  return database.withTransaction(async (tx) => {
    await lockGuestCart(tx, sessionHash)
    return updateItem(tx, sessionHash, itemId, quantity)
  })
}

export async function deleteGuestCartItem(database, sessionHash, itemId) {
  return database.withTransaction(async (tx) => {
    await lockGuestCart(tx, sessionHash)
    const result = await tx.query(DELETE_ITEM_SQL, [itemId, sessionHash])
    return result.rows.length === 1
  })
}

export async function findAccountCart(database, userId) {
  const result = await database.query(ACCOUNT_CART_SQL, [userId])
  return presentCart(result.rows)
}

export async function addAccountCartItem(
  database,
  userId,
  { productId, quantity },
) {
  return database.withTransaction(async (tx) => {
    await lockAccountCart(tx, userId)
    return addAccountItem(tx, userId, productId, quantity)
  })
}

export async function updateAccountCartItem(
  database,
  userId,
  { itemId, quantity },
) {
  return database.withTransaction(async (tx) => {
    await lockAccountCart(tx, userId)
    return updateAccountItem(tx, userId, itemId, quantity)
  })
}

export async function deleteAccountCartItem(database, userId, itemId) {
  return database.withTransaction(async (tx) => {
    await lockAccountCart(tx, userId)
    const result = await tx.query(DELETE_ACCOUNT_ITEM_SQL, [itemId, userId])
    return result.rows.length === 1
  })
}

export async function mergeGuestCart(database, userId, sessionHash) {
  return database.withTransaction(async (tx) => {
    await lockGuestCart(tx, sessionHash)
    await lockAccountCart(tx, userId)

    const guest = await tx.query(LOCK_GUEST_CART_MERGE_SQL, [sessionHash])
    const guestCart = guest.rows[0]

    if (!guestCart) {
      return
    }

    const guestLines = await tx.query(LOCK_MERGE_LINES_SQL, [guestCart.id])

    if (guestLines.rows.length === 0) {
      return
    }

    assertCartCurrency(guestCart.currency)
    const account = await tx.query(LOCK_ACCOUNT_CART_MERGE_SQL, [userId])
    const accountCart = account.rows[0]

    if (!accountCart) {
      assertMergeLines(guestLines.rows)
      const adopted = await tx.query(ADOPT_GUEST_CART_SQL, [
        userId,
        guestCart.id,
        sessionHash,
      ])

      if (adopted.rows.length !== 1) {
        throw new TypeError('Invalid cart write result')
      }

      return
    }

    assertCartCurrency(accountCart.currency)
    const accountLines = await tx.query(LOCK_MERGE_LINES_SQL, [accountCart.id])
    assertMergeLines(combinedLines(accountLines.rows, guestLines.rows))

    for (const line of guestLines.rows) {
      const written = await tx.query(UPSERT_ITEM_SQL, [
        accountCart.id,
        line.product_id,
        line.quantity,
      ])

      if (written.rows.length !== 1) {
        throw new CartMergeError('quantity')
      }
    }

    const abandoned = await tx.query(ABANDON_GUEST_CART_SQL, [
      guestCart.id,
      sessionHash,
    ])

    if (abandoned.rows.length !== 1) {
      throw new TypeError('Invalid cart write result')
    }
  })
}

async function lockGuestCart(tx, sessionHash) {
  await lockOwner(tx, GUEST_CART_LOCK_NAMESPACE, guestCartLockKey(sessionHash))
}

async function lockAccountCart(tx, userId) {
  await lockOwner(tx, ACCOUNT_CART_LOCK_NAMESPACE, accountCartLockKey(userId))
}

async function lockOwner(tx, namespace, key) {
  assertInt32(namespace)
  assertInt32(key)
  await tx.query(LOCK_OWNER_SQL, [namespace, key])
}

function lockKeyFromHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{8}/i.test(hex)) {
    throw new TypeError('Invalid cart owner key')
  }

  return Buffer.from(hex.slice(0, 8), 'hex').readInt32BE(0)
}

function assertInt32(value) {
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new TypeError('Invalid cart lock key')
  }
}

async function addItem(tx, sessionHash, productId, quantity) {
  const productResult = await tx.query(PRODUCT_SQL, [productId])
  const product = productResult.rows[0]

  if (!product) {
    return { outcome: 'missing' }
  }

  if (product.is_active !== true) {
    return { outcome: 'inactive' }
  }

  if (text(product.currency) !== 'PLN') {
    return { outcome: 'currency' }
  }

  await tx.query(INSERT_CART_SQL, [sessionHash])
  const locked = await tx.query(LOCK_CART_SQL, [sessionHash])
  const cartId = locked.rows[0]?.id

  if (locked.rows.length !== 1 || typeof cartId !== 'string') {
    throw new TypeError('Invalid cart write result')
  }

  const lines = await tx.query(LINES_SQL, [cartId])
  const plan = planQuantity(lines.rows, {
    productId,
    unit: readMoney(product.price_amount),
    nextQuantity: currentQuantity(lines.rows, productId) + BigInt(quantity),
    countsTowardTotal: true,
  })

  if (plan === 'quantity') {
    return { outcome: 'overflow' }
  }

  if (plan === 'amount') {
    throw new CartAmountError()
  }

  const written = await tx.query(UPSERT_ITEM_SQL, [cartId, productId, quantity])

  if (written.rows.length !== 1) {
    return { outcome: 'overflow' }
  }

  return { outcome: 'ready', written: 1, carts: 1 }
}

async function addAccountItem(tx, userId, productId, quantity) {
  const productResult = await tx.query(PRODUCT_SQL, [productId])
  const product = productResult.rows[0]

  if (!product) {
    return { outcome: 'missing' }
  }

  if (product.is_active !== true) {
    return { outcome: 'inactive' }
  }

  if (text(product.currency) !== 'PLN') {
    return { outcome: 'currency' }
  }

  await tx.query(INSERT_ACCOUNT_CART_SQL, [userId])
  const locked = await tx.query(LOCK_ACCOUNT_CART_SQL, [userId])
  const cartId = locked.rows[0]?.id

  if (locked.rows.length !== 1 || typeof cartId !== 'string') {
    throw new TypeError('Invalid cart write result')
  }

  const lines = await tx.query(LINES_SQL, [cartId])
  const plan = planQuantity(lines.rows, {
    productId,
    unit: readMoney(product.price_amount),
    nextQuantity: currentQuantity(lines.rows, productId) + BigInt(quantity),
    countsTowardTotal: true,
  })

  if (plan === 'quantity') {
    return { outcome: 'overflow' }
  }

  if (plan === 'amount') {
    throw new CartAmountError()
  }

  const written = await tx.query(UPSERT_ITEM_SQL, [cartId, productId, quantity])

  if (written.rows.length !== 1) {
    return { outcome: 'overflow' }
  }

  return { outcome: 'ready', written: 1, carts: 1 }
}

async function updateAccountItem(tx, userId, itemId, quantity) {
  const locked = await tx.query(LOCK_ACCOUNT_ITEM_SQL, [itemId, userId])
  const item = locked.rows[0]

  if (!item) {
    return false
  }

  const lines = await tx.query(LINES_SQL, [item.cart_id])
  const current = lines.rows.find((line) => line.product_id === item.product_id)

  if (!current) {
    throw new TypeError('Invalid cart write result')
  }

  const plan = planQuantity(lines.rows, {
    productId: item.product_id,
    unit: readMoney(current.price_amount),
    nextQuantity: BigInt(quantity),
    countsTowardTotal: text(current.currency) === 'PLN',
  })

  if (plan === 'amount') {
    throw new CartAmountError()
  }

  const updated = await tx.query(UPDATE_ACCOUNT_ITEM_SQL, [
    itemId,
    userId,
    quantity,
  ])
  return updated.rows.length === 1
}

async function updateItem(tx, sessionHash, itemId, quantity) {
  const locked = await tx.query(LOCK_ITEM_SQL, [itemId, sessionHash])
  const item = locked.rows[0]

  if (!item) {
    return false
  }

  const lines = await tx.query(LINES_SQL, [item.cart_id])
  const current = lines.rows.find((line) => line.product_id === item.product_id)

  if (!current) {
    throw new TypeError('Invalid cart write result')
  }

  const plan = planQuantity(lines.rows, {
    productId: item.product_id,
    unit: readMoney(current.price_amount),
    nextQuantity: BigInt(quantity),
    countsTowardTotal: text(current.currency) === 'PLN',
  })

  if (plan === 'amount') {
    throw new CartAmountError()
  }

  const updated = await tx.query(UPDATE_ITEM_SQL, [
    itemId,
    sessionHash,
    quantity,
  ])
  return updated.rows.length === 1
}

function assertCartCurrency(currency) {
  if (text(currency) !== 'PLN') {
    throw new CartMergeError('currency')
  }
}

function assertMergeLines(lines) {
  let total = 0n

  for (const line of lines) {
    if (text(line.currency) !== 'PLN') {
      throw new CartMergeError('currency')
    }

    const quantity =
      typeof line.quantity === 'bigint'
        ? line.quantity
        : readQuantity(line.quantity)

    if (quantity > MAX_QUANTITY) {
      throw new CartMergeError('quantity')
    }

    const price = readMoney(line.price_amount)
    const lineAmount = price * quantity

    if (
      price > MAX_SAFE_AMOUNT ||
      lineAmount > MAX_SAFE_AMOUNT ||
      total + lineAmount > MAX_SAFE_AMOUNT
    ) {
      throw new CartAmountError()
    }

    total += lineAmount
  }
}

function combinedLines(accountLines, guestLines) {
  const lines = new Map()

  for (const line of accountLines) {
    lines.set(line.product_id, {
      ...line,
      quantity: readQuantity(line.quantity),
    })
  }

  for (const line of guestLines) {
    const quantity = readQuantity(line.quantity)
    const current = lines.get(line.product_id)

    if (!current) {
      lines.set(line.product_id, {
        ...line,
        quantity,
      })
      continue
    }

    current.quantity += quantity
    current.price_amount = line.price_amount
    current.currency = line.currency
  }

  return [...lines.values()]
}

function planQuantity(
  lines,
  { productId, unit, nextQuantity, countsTowardTotal },
) {
  if (!Array.isArray(lines)) {
    throw new TypeError('Invalid cart rows')
  }

  if (nextQuantity > MAX_QUANTITY) {
    return 'quantity'
  }

  let total = 0n
  let oldContribution = 0n

  for (const line of lines) {
    const price = readMoney(line.price_amount)
    const quantity = readQuantity(line.quantity)
    const lineAmount = price * quantity
    const billable = text(line.currency) === 'PLN'

    if (price > MAX_SAFE_AMOUNT || lineAmount > MAX_SAFE_AMOUNT) {
      return 'amount'
    }

    if (billable) {
      total += lineAmount

      if (total > MAX_SAFE_AMOUNT) {
        return 'amount'
      }
    }

    if (line.product_id === productId && billable) {
      oldContribution = lineAmount
    }
  }

  const nextLine = unit * nextQuantity

  if (unit > MAX_SAFE_AMOUNT || nextLine > MAX_SAFE_AMOUNT) {
    return 'amount'
  }

  if (
    countsTowardTotal &&
    total - oldContribution + nextLine > MAX_SAFE_AMOUNT
  ) {
    return 'amount'
  }

  return 'ok'
}

function currentQuantity(lines, productId) {
  const line = lines.find((item) => item.product_id === productId)

  if (!line) {
    return 0n
  }

  return readQuantity(line.quantity)
}

function presentCart(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('Invalid cart rows')
  }

  const items = []
  let total = 0n

  for (const row of rows) {
    const price = readMoney(row.price_amount)
    const quantity = readQuantity(row.quantity)
    const lineAmount = price * quantity
    const currency = text(row.currency)

    if (
      price > MAX_SAFE_AMOUNT ||
      lineAmount > MAX_SAFE_AMOUNT ||
      (currency === 'PLN' && total + lineAmount > MAX_SAFE_AMOUNT)
    ) {
      throw new CartAmountError()
    }

    if (typeof row.id !== 'string' || typeof row.product_id !== 'string') {
      throw new TypeError('Invalid cart line')
    }

    if (typeof row.name !== 'string') {
      throw new TypeError('Invalid cart line')
    }

    if (currency === 'PLN') {
      total += lineAmount
    }

    items.push({
      id: row.id,
      product_id: row.product_id,
      name: row.name,
      price_amount: Number(price),
      currency,
      quantity: Number(quantity),
      line_amount: Number(lineAmount),
    })
  }

  return {
    currency: 'PLN',
    items,
    total_amount: Number(total),
  }
}

function readMoney(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new TypeError('Invalid cart amount')
    }

    return value
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Invalid cart amount')
    }

    return BigInt(value)
  }

  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return BigInt(value)
  }

  throw new TypeError('Invalid cart amount')
}

function readQuantity(value) {
  const quantity = typeof value === 'string' ? Number(value) : value

  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new TypeError('Invalid cart count')
  }

  return BigInt(quantity)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}
