import pg from 'pg'
import { pathToFileURL } from 'node:url'

export const LOCAL_CATALOG_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const REFUSED_MESSAGE =
  'Refusing to seed: database is not the local project PostgreSQL.'

const CATEGORIES = [
  {
    name: 'Akcesoria',
    slug: 'akcesoria',
    description: null,
    isActive: true,
    sortOrder: 1,
  },
  {
    name: 'Wyposażenie',
    slug: 'wyposazenie',
    description: null,
    isActive: true,
    sortOrder: 2,
  },
]

const PRODUCTS = [
  {
    name: 'Etui ochronne',
    slug: 'etui-ochronne',
    categorySlug: 'akcesoria',
    description: null,
    productType: 'physical',
    sku: 'local-etui-ochronne',
    priceAmount: 4999,
    currency: 'PLN',
    taxStatus: 'standard',
    vatRate: '23.00',
    isActive: true,
    stockQuantity: 10,
  },
  {
    name: 'Organizer',
    slug: 'organizer',
    categorySlug: 'akcesoria',
    description: null,
    productType: 'physical',
    sku: 'local-organizer',
    priceAmount: 7900,
    currency: 'PLN',
    taxStatus: 'standard',
    vatRate: '23.00',
    isActive: true,
    stockQuantity: 5,
  },
  {
    name: 'Zestaw podróżny',
    slug: 'zestaw-podrozny',
    categorySlug: 'wyposazenie',
    description: null,
    productType: 'physical',
    sku: 'local-zestaw-podrozny',
    priceAmount: 12900,
    currency: 'PLN',
    taxStatus: 'standard',
    vatRate: '23.00',
    isActive: true,
    stockQuantity: 3,
  },
]

export class CatalogSeedError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CatalogSeedError'
    this.code = code
  }
}

function refused() {
  return new CatalogSeedError('CATALOG_SEED_REFUSED', REFUSED_MESSAGE)
}

function conflict(kind, slug) {
  return new CatalogSeedError(
    'CATALOG_SEED_CONFLICT',
    `Catalog seed conflict for existing ${kind} "${slug}".`,
  )
}

export function assertLocalCatalogDatabase(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw refused()
  }

  let url

  try {
    url = new URL(connectionString)
  } catch {
    throw refused()
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const protocolOk =
    url.protocol === 'postgresql:' || url.protocol === 'postgres:'
  const local =
    protocolOk &&
    LOCAL_HOSTS.has(url.hostname.toLowerCase()) &&
    url.port === '54322' &&
    databaseName === 'postgres' &&
    decodeURIComponent(url.username) === 'postgres' &&
    decodeURIComponent(url.password) === 'postgres' &&
    url.search === '' &&
    url.hash === ''

  if (!local) {
    throw refused()
  }
}

function sameText(actual, expected) {
  const left = actual == null ? null : String(actual)
  const right = expected == null ? null : String(expected)
  return left === right
}

function sameInteger(actual, expected) {
  if (actual == null || expected == null) {
    return actual == null && expected == null
  }

  try {
    return BigInt(actual) === BigInt(expected)
  } catch {
    return false
  }
}

function sameRate(actual, expected) {
  if (actual == null || expected == null) {
    return actual == null && expected == null
  }

  const left = Number(actual)
  const right = Number(expected)
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    left.toFixed(2) === right.toFixed(2)
  )
}

function sameCategory(row, category) {
  return (
    sameText(row.name, category.name) &&
    sameText(row.slug, category.slug) &&
    sameText(row.description, category.description) &&
    row.is_active === category.isActive &&
    sameInteger(row.sort_order, category.sortOrder)
  )
}

function sameProduct(row, product) {
  return (
    sameText(row.name, product.name) &&
    sameText(row.slug, product.slug) &&
    sameText(row.category_slug, product.categorySlug) &&
    sameText(row.description, product.description) &&
    sameText(row.product_type, product.productType) &&
    sameText(row.sku, product.sku) &&
    sameInteger(row.price_amount, product.priceAmount) &&
    sameText(String(row.currency).trim(), product.currency) &&
    sameText(row.tax_status, product.taxStatus) &&
    sameRate(row.vat_rate, product.vatRate) &&
    row.is_active === product.isActive &&
    sameInteger(row.stock_quantity, product.stockQuantity)
  )
}

async function ensureCategory(client, category) {
  const existing = await client.query(
    `
      SELECT name, slug, description, is_active, sort_order
      FROM public.categories
      WHERE slug = $1
    `,
    [category.slug],
  )

  if (existing.rows.length > 1) {
    throw conflict('category', category.slug)
  }

  if (existing.rows.length === 1) {
    if (!sameCategory(existing.rows[0], category)) {
      throw conflict('category', category.slug)
    }

    return false
  }

  await client.query(
    `
      INSERT INTO public.categories (name, slug, description, is_active, sort_order)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      category.name,
      category.slug,
      category.description,
      category.isActive,
      category.sortOrder,
    ],
  )
  return true
}

async function ensureProduct(client, product) {
  const existing = await client.query(
    `
      SELECT
        p.name,
        p.slug,
        p.description,
        p.product_type,
        p.sku,
        p.price_amount,
        p.currency,
        p.tax_status,
        p.vat_rate,
        p.is_active,
        p.stock_quantity,
        c.slug AS category_slug
      FROM public.products AS p
      LEFT JOIN public.categories AS c ON c.id = p.category_id
      WHERE p.slug = $1 OR p.sku = $2
    `,
    [product.slug, product.sku],
  )

  if (existing.rows.length > 1) {
    throw conflict('product', product.slug)
  }

  if (existing.rows.length === 1) {
    if (!sameProduct(existing.rows[0], product)) {
      throw conflict('product', product.slug)
    }

    return false
  }

  const category = await client.query(
    `
      SELECT id
      FROM public.categories
      WHERE slug = $1
    `,
    [product.categorySlug],
  )

  if (category.rows.length !== 1) {
    throw conflict('category', product.categorySlug)
  }

  await client.query(
    `
      INSERT INTO public.products (
        category_id, name, slug, description, product_type, sku,
        price_amount, currency, tax_status, vat_rate, is_active, stock_quantity
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      category.rows[0].id,
      product.name,
      product.slug,
      product.description,
      product.productType,
      product.sku,
      product.priceAmount,
      product.currency,
      product.taxStatus,
      product.vatRate,
      product.isActive,
      product.stockQuantity,
    ],
  )
  return true
}

async function assertProjectCatalog(client) {
  const result = await client.query(
    `
      SELECT
        to_regclass('public.categories')::text AS categories,
        to_regclass('public.products')::text AS products
    `,
  )
  const row = result.rows[0]

  if (
    row?.categories !== 'categories' &&
    row?.categories !== 'public.categories'
  ) {
    throw refused()
  }

  if (row?.products !== 'products' && row?.products !== 'public.products') {
    throw refused()
  }
}

export async function seedLocalCatalog(client) {
  await client.query('BEGIN')

  try {
    let insertedCategories = 0
    let insertedProducts = 0

    for (const category of CATEGORIES) {
      if (await ensureCategory(client, category)) {
        insertedCategories += 1
      }
    }

    for (const product of PRODUCTS) {
      if (await ensureProduct(client, product)) {
        insertedProducts += 1
      }
    }

    await client.query('COMMIT')
    return {
      insertedCategories,
      insertedProducts,
      unchangedCategories: CATEGORIES.length - insertedCategories,
      unchangedProducts: PRODUCTS.length - insertedProducts,
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The original failure is the one that matters.
    }

    if (error instanceof CatalogSeedError) {
      throw error
    }

    throw new CatalogSeedError('CATALOG_SEED_FAILED', 'Catalog seed failed.')
  }
}

async function connectLocal(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
  })

  try {
    const client = await pool.connect()
    const release = client.release.bind(client)
    client.release = async () => {
      release()
      await pool.end()
    }
    return client
  } catch {
    await pool.end()
    throw new CatalogSeedError(
      'CATALOG_SEED_REFUSED',
      'Refusing to seed: local database is not available.',
    )
  }
}

export async function runLocalCatalogSeed({
  connectionString,
  connect = connectLocal,
  nodeEnv = process.env.NODE_ENV,
}) {
  if (nodeEnv === 'production') {
    throw refused()
  }

  assertLocalCatalogDatabase(connectionString)
  const client = await connect(connectionString)

  try {
    await assertProjectCatalog(client)
    return await seedLocalCatalog(client)
  } finally {
    await client.release()
  }
}

function isDirectRun() {
  const entry = process.argv[1]

  if (!entry) {
    return false
  }

  return import.meta.url === pathToFileURL(entry).href
}

if (isDirectRun()) {
  const connectionString =
    process.env.DATABASE_URL ?? LOCAL_CATALOG_DATABASE_URL

  runLocalCatalogSeed({ connectionString })
    .then((summary) => {
      console.log(JSON.stringify(summary))
    })
    .catch((error) => {
      const message =
        error instanceof CatalogSeedError
          ? error.message
          : 'Catalog seed failed.'
      console.error(message)
      process.exitCode = 1
    })
}
