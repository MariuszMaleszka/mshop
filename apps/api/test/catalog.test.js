import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerCatalogRoutes } from '../src/catalog/routes.js'
import { listCategories, listProducts } from '../src/catalog/repository.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

const categoryId = '33333333-3333-4333-8333-333333333333'
const productId = '44444444-4444-4444-8444-444444444444'
const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
})

function fakeDatabase(query) {
  const calls = []

  return {
    calls,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      calls.push({ sql, params })
      return query(sql, params)
    },
  }
}

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

function appWith(database) {
  return createApp(config, {
    database,
    registerRoutes(router) {
      registerCatalogRoutes(router, { database })
    },
  })
}

describe('catalog queries', () => {
  it('lists only active categories with stable sort and pagination parameters', async () => {
    const database = fakeDatabase(async (sql) => {
      if (sql.includes('count(*)')) {
        return { rows: [{ total: 45 }] }
      }

      return {
        rows: [
          {
            id: categoryId,
            name: 'Prints',
            slug: 'prints',
            description: null,
            sort_order: 1,
          },
        ],
      }
    })
    const result = await listCategories(database, { limit: 20, offset: 20 })

    assert.equal(database.calls.length, 2)
    assert.match(database.calls[0].sql, /is_active = true/)
    assert.match(
      database.calls[0].sql,
      /ORDER BY sort_order ASC, name ASC, id ASC/,
    )
    assert.equal(database.calls[0].sql.includes('SELECT *'), false)
    assert.deepEqual(database.calls[0].params, [20, 20])
    assert.equal(result.total, 45)
    assert.deepEqual(result.rows[0], {
      id: categoryId,
      name: 'Prints',
      slug: 'prints',
      description: null,
      sort_order: 1,
    })
  })

  it('passes product filters as parameters and keeps both filters in the count', async () => {
    const database = fakeDatabase(async (sql) => {
      if (sql.includes('count(*)')) {
        return { rows: [{ total: 1 }] }
      }

      return {
        rows: [
          {
            id: productId,
            category_id: categoryId,
            name: 'Session',
            slug: 'session',
            description: 'Portrait',
            product_type: 'service',
            sku: null,
            price_amount: '12900',
            currency: 'PLN',
            tax_status: 'standard',
            vat_rate: '23.00',
            stock_quantity: null,
          },
        ],
      }
    })
    const result = await listProducts(database, {
      limit: 10,
      offset: 10,
      categoryId,
      productType: 'service',
    })

    assert.match(database.calls[0].sql, /is_active = true/)
    assert.match(database.calls[0].sql, /category_id = \$1/)
    assert.match(database.calls[0].sql, /product_type = \$2/)
    assert.match(database.calls[0].sql, /ORDER BY name ASC, id ASC/)
    assert.match(database.calls[0].sql, /LIMIT \$3 OFFSET \$4/)
    assert.equal(database.calls[0].sql.includes(categoryId), false)
    assert.equal(database.calls[0].sql.includes('service'), false)
    assert.deepEqual(database.calls[0].params, [categoryId, 'service', 10, 10])
    assert.match(database.calls[1].sql, /category_id = \$1/)
    assert.match(database.calls[1].sql, /product_type = \$2/)
    assert.deepEqual(database.calls[1].params, [categoryId, 'service'])
    assert.equal(result.rows[0].price_amount, 12900)
    assert.equal(result.rows[0].vat_rate, 23)
    assert.equal(result.rows[0].currency, 'PLN')
  })

  it('clears category_id in product detail SQL when the category is inactive', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const { findActiveProduct } = await import('../src/catalog/repository.js')
    await findActiveProduct(database, productId)

    assert.match(database.calls[0].sql, /p\.is_active = true/)
    assert.match(
      database.calls[0].sql,
      /CASE WHEN c\.is_active IS TRUE THEN p\.category_id ELSE NULL END/,
    )
    assert.deepEqual(database.calls[0].params, [productId])
    assert.equal(database.calls[0].sql.includes(productId), false)
  })
})

describe('public catalog routes', () => {
  it('returns a category page without authentication', async () => {
    const database = fakeDatabase(async (sql) => {
      if (sql.includes('count(*)')) {
        return { rows: [{ total: 1 }] }
      }

      return {
        rows: [
          {
            id: categoryId,
            name: 'Prints',
            slug: 'prints',
            description: 'Paper',
            sort_order: 1,
          },
        ],
      }
    })
    const { server, baseUrl } = await listen(appWith(database))

    try {
      const response = await fetch(
        `${baseUrl}/api/v1/categories?page=1&limit=20`,
      )
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.deepEqual(body, {
        data: [
          {
            id: categoryId,
            name: 'Prints',
            slug: 'prints',
            description: 'Paper',
            sort_order: 1,
          },
        ],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      })
    } finally {
      await close(server)
    }
  })

  it('returns 404 when an active category row is missing', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const { server, baseUrl } = await listen(appWith(database))

    try {
      const response = await fetch(`${baseUrl}/api/v1/categories/${categoryId}`)
      const body = await response.json()

      assert.equal(response.status, 404)
      assert.equal(body.error.code, 'NOT_FOUND')
      assert.match(database.calls[0].sql, /is_active = true/)
    } finally {
      await close(server)
    }
  })

  it('rejects an invalid category id and an invalid product type before querying', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }))
    const { server, baseUrl } = await listen(appWith(database))

    try {
      const badId = await fetch(`${baseUrl}/api/v1/products/not-a-uuid`)
      const badType = await fetch(
        `${baseUrl}/api/v1/products?product_type=bundle`,
      )
      const idBody = await badId.json()
      const typeBody = await badType.json()

      assert.equal(badId.status, 400)
      assert.equal(idBody.error.code, 'VALIDATION_ERROR')
      assert.equal(badType.status, 400)
      assert.equal(typeBody.error.code, 'VALIDATION_ERROR')
      assert.equal(database.calls.length, 0)
      assert.equal(JSON.stringify(idBody).includes('not-a-uuid'), false)
    } finally {
      await close(server)
    }
  })

  it('returns 503 without a database error when a catalog query fails', async () => {
    const database = fakeDatabase(async () => {
      throw new Error('password=secret relation categories')
    })
    const { server, baseUrl } = await listen(appWith(database))

    try {
      const response = await fetch(`${baseUrl}/api/v1/categories`)
      const body = await response.json()

      assert.equal(response.status, 503)
      assert.equal(body.error.code, 'SERVICE_UNAVAILABLE')
      assert.equal(JSON.stringify(body).includes('password'), false)
      assert.equal(JSON.stringify(body).includes('categories'), false)
    } finally {
      await close(server)
    }
  })
})
