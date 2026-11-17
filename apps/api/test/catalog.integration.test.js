import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { registerCatalogRoutes } from '../src/catalog/routes.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

function localDatabaseUrl() {
  const configured = process.env.DATABASE_URL

  if (!configured) {
    return 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  }

  try {
    const url = new URL(configured)
    return LOCAL_HOSTS.has(url.hostname) ? configured : null
  } catch {
    return null
  }
}

const databaseUrl = localDatabaseUrl()
const pool = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
    })
  : null

let client = null
let available = false

if (pool) {
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    available = true
  } catch {
    client?.release()
    client = null
    await pool.end()
  }
}

const skip = available ? false : 'local database is not available'
const database = {
  async query(text, params = []) {
    return client.query(text, params)
  },
}
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

async function insertCategory({ name, sortOrder, isActive }) {
  const result = await client.query(
    `
      INSERT INTO public.categories (name, slug, description, is_active, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    [name, `category-${randomUUID()}`, 'Catalog test', isActive, sortOrder],
  )
  return result.rows[0].id
}

async function insertProduct({ id, categoryId, name, productType, isActive }) {
  await client.query(
    `
      INSERT INTO public.products (
        id, category_id, name, slug, description, product_type, sku,
        price_amount, currency, tax_status, vat_rate, is_active, stock_quantity
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PLN', 'standard', 23, $9, 4)
    `,
    [
      id,
      categoryId,
      name,
      `product-${randomUUID()}`,
      'Catalog test',
      productType,
      `sku-${randomUUID()}`,
      12900,
      isActive,
    ],
  )
}

describe('catalog database', { concurrency: 1 }, () => {
  after(async () => {
    if (!client) {
      return
    }

    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  })

  it('serves active categories and hides inactive ones', { skip }, async () => {
    const first = await insertCategory({
      name: 'Alpha',
      sortOrder: 1,
      isActive: true,
    })
    const second = await insertCategory({
      name: 'Zulu',
      sortOrder: 1,
      isActive: true,
    })
    const third = await insertCategory({
      name: 'Middle',
      sortOrder: 2,
      isActive: true,
    })
    const inactive = await insertCategory({
      name: 'Hidden',
      sortOrder: 0,
      isActive: false,
    })
    const app = createApp(config, {
      database,
      registerRoutes(router) {
        registerCatalogRoutes(router, { database })
      },
    })
    const { server, baseUrl } = await listen(app)

    try {
      const listed = await fetch(`${baseUrl}/api/v1/categories?limit=100`)
      const listBody = await listed.json()
      const ids = []
      ids.push(...listBody.data.map((row) => row.id))

      for (let page = 2; page <= listBody.meta.totalPages; page += 1) {
        const next = await fetch(
          `${baseUrl}/api/v1/categories?limit=100&page=${page}`,
        )
        const nextBody = await next.json()
        ids.push(...nextBody.data.map((row) => row.id))
      }

      const detail = await fetch(`${baseUrl}/api/v1/categories/${first}`)
      const detailBody = await detail.json()
      const hidden = await fetch(`${baseUrl}/api/v1/categories/${inactive}`)
      const missing = await fetch(
        `${baseUrl}/api/v1/categories/55555555-5555-4555-8555-555555555555`,
      )

      assert.equal(listed.status, 200)
      assert.equal(ids.includes(inactive), false)
      assert.equal(ids.indexOf(first) < ids.indexOf(second), true)
      assert.equal(ids.indexOf(second) < ids.indexOf(third), true)
      assert.equal(listBody.meta.total, ids.length)
      assert.equal(detail.status, 200)
      assert.equal(detailBody.data.id, first)
      assert.deepEqual(detailBody.meta, {})
      assert.equal(hidden.status, 404)
      assert.equal(missing.status, 404)
    } finally {
      await close(server)
    }
  })

  it(
    'filters active products and hides an inactive category on the detail',
    { skip },
    async () => {
      const portraits = await insertCategory({
        name: 'Portraits',
        sortOrder: 3,
        isActive: true,
      })
      const albums = await insertCategory({
        name: 'Albums',
        sortOrder: 4,
        isActive: true,
      })
      const hiddenCategory = await insertCategory({
        name: 'Archived',
        sortOrder: 5,
        isActive: false,
      })
      const alpha = '66666666-6666-4666-8666-666666666661'
      const beta = '66666666-6666-4666-8666-666666666662'
      const digital = '66666666-6666-4666-8666-666666666663'
      const archived = '66666666-6666-4666-8666-666666666664'
      const inactiveProduct = '66666666-6666-4666-8666-666666666665'
      await insertProduct({
        id: beta,
        categoryId: portraits,
        name: 'Beta',
        productType: 'physical',
        isActive: true,
      })
      await insertProduct({
        id: alpha,
        categoryId: portraits,
        name: 'Alpha',
        productType: 'physical',
        isActive: true,
      })
      await insertProduct({
        id: digital,
        categoryId: portraits,
        name: 'Download',
        productType: 'digital',
        isActive: true,
      })
      await insertProduct({
        id: archived,
        categoryId: hiddenCategory,
        name: 'Old session',
        productType: 'service',
        isActive: true,
      })
      await insertProduct({
        id: inactiveProduct,
        categoryId: albums,
        name: 'Inactive print',
        productType: 'physical',
        isActive: false,
      })
      const app = createApp(config, {
        database,
        registerRoutes(router) {
          registerCatalogRoutes(router, { database })
        },
      })
      const { server, baseUrl } = await listen(app)

      try {
        const filtered = await fetch(
          `${baseUrl}/api/v1/products?category_id=${portraits}&product_type=physical&limit=20`,
        )
        const filteredBody = await filtered.json()
        const typed = await fetch(
          `${baseUrl}/api/v1/products?product_type=digital&limit=100`,
        )
        const typedBody = await typed.json()
        const detail = await fetch(`${baseUrl}/api/v1/products/${archived}`)
        const detailBody = await detail.json()
        const hidden = await fetch(
          `${baseUrl}/api/v1/products/${inactiveProduct}`,
        )
        const missing = await fetch(
          `${baseUrl}/api/v1/products/77777777-7777-4777-8777-777777777777`,
        )

        assert.equal(filtered.status, 200)
        assert.deepEqual(
          filteredBody.data.map((row) => row.id),
          [alpha, beta],
        )
        assert.equal(filteredBody.meta.total, 2)
        assert.equal(filteredBody.meta.totalPages, 1)
        assert.equal(filteredBody.data[0].price_amount, 12900)
        assert.equal(filteredBody.data[0].vat_rate, 23)
        assert.equal(
          typedBody.data.some((row) => row.id === digital),
          true,
        )
        assert.equal(
          typedBody.data.some((row) => row.id === alpha),
          false,
        )
        assert.equal(detail.status, 200)
        assert.equal(detailBody.data.category_id, null)
        assert.equal(detailBody.data.product_type, 'service')
        assert.deepEqual(detailBody.meta, {})
        assert.equal(hidden.status, 404)
        assert.equal(missing.status, 404)
        const unauthenticated = await fetch(
          `${baseUrl}/api/v1/products/${alpha}`,
        )
        assert.equal(unauthenticated.status, 200)
      } finally {
        await close(server)
      }
    },
  )
})
