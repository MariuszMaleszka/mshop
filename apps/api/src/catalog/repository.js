const CATEGORY_FIELDS = 'id, name, slug, description, sort_order'
const PRODUCT_FIELDS =
  'id, category_id, name, slug, description, product_type, sku, price_amount, currency, tax_status, vat_rate, stock_quantity'

const CATEGORY_LIST_SQL = `
  SELECT ${CATEGORY_FIELDS}
  FROM public.categories
  WHERE is_active = true
  ORDER BY sort_order ASC, name ASC, id ASC
  LIMIT $1 OFFSET $2
`

const CATEGORY_COUNT_SQL = `
  SELECT count(*)::int AS total
  FROM public.categories
  WHERE is_active = true
`

const CATEGORY_DETAIL_SQL = `
  SELECT ${CATEGORY_FIELDS}
  FROM public.categories
  WHERE id = $1 AND is_active = true
`

const PRODUCT_DETAIL_SQL = `
  SELECT
    p.id,
    CASE WHEN c.is_active IS TRUE THEN p.category_id ELSE NULL END AS category_id,
    p.name,
    p.slug,
    p.description,
    p.product_type,
    p.sku,
    p.price_amount,
    p.currency,
    p.tax_status,
    p.vat_rate,
    p.stock_quantity
  FROM public.products AS p
  LEFT JOIN public.categories AS c ON c.id = p.category_id
  WHERE p.id = $1 AND p.is_active = true
`

export async function listCategories(database, { limit, offset }) {
  const listed = await database.query(CATEGORY_LIST_SQL, [limit, offset])
  const counted = await database.query(CATEGORY_COUNT_SQL)
  return {
    rows: listed.rows.map(mapCategory),
    total: readTotal(counted),
  }
}

export async function findActiveCategory(database, id) {
  const result = await database.query(CATEGORY_DETAIL_SQL, [id])
  const row = result.rows[0]
  return row ? mapCategory(row) : null
}

export async function listProducts(
  database,
  { limit, offset, categoryId, productType },
) {
  const filters = productFilters({ categoryId, productType })
  const params = [...filters.params, limit, offset]
  const limitIndex = filters.params.length + 1
  const offsetIndex = filters.params.length + 2
  const listed = await database.query(
    `
      SELECT ${PRODUCT_FIELDS}
      FROM public.products
      WHERE ${filters.where}
      ORDER BY name ASC, id ASC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `,
    params,
  )
  const counted = await database.query(
    `
      SELECT count(*)::int AS total
      FROM public.products
      WHERE ${filters.where}
    `,
    filters.params,
  )

  return {
    rows: listed.rows.map(mapProduct),
    total: readTotal(counted),
  }
}

export async function findActiveProduct(database, id) {
  const result = await database.query(PRODUCT_DETAIL_SQL, [id])
  const row = result.rows[0]
  return row ? mapProduct(row) : null
}

function productFilters({ categoryId, productType }) {
  const clauses = ['is_active = true']
  const params = []

  if (categoryId) {
    params.push(categoryId)
    clauses.push(`category_id = $${params.length}`)
  }

  if (productType) {
    params.push(productType)
    clauses.push(`product_type = $${params.length}`)
  }

  return {
    where: clauses.join(' AND '),
    params,
  }
}

function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    sort_order: row.sort_order,
  }
}

function mapProduct(row) {
  return {
    id: row.id,
    category_id: row.category_id ?? null,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    product_type: row.product_type,
    sku: row.sku ?? null,
    price_amount: readAmount(row.price_amount),
    currency:
      typeof row.currency === 'string' ? row.currency.trim() : row.currency,
    tax_status: row.tax_status,
    vat_rate:
      row.vat_rate === null || row.vat_rate === undefined
        ? null
        : readRate(row.vat_rate),
    stock_quantity: row.stock_quantity ?? null,
  }
}

function readTotal(result) {
  const total = Number(result.rows[0]?.total)
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError('Invalid catalog total')
  }
  return total
}

function readAmount(value) {
  const amount = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError('Invalid catalog amount')
  }
  return amount
}

function readRate(value) {
  const rate = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(rate)) {
    throw new TypeError('Invalid catalog rate')
  }
  return rate
}
