import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CatalogSeedError,
  LOCAL_CATALOG_DATABASE_URL,
  assertLocalCatalogDatabase,
  runLocalCatalogSeed,
  seedLocalCatalog,
} from '../scripts/seed-local-catalog.js'

function createClient({ failOnProductInsert = false, project = true } = {}) {
  const committed = {
    categories: new Map(),
    products: new Map(),
  }
  let tx = null
  const queries = []

  function store() {
    if (!tx) {
      throw new Error('query outside a transaction')
    }

    return tx
  }

  return {
    committed,
    queries,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      queries.push(sql)

      if (sql === 'BEGIN') {
        tx = {
          categories: new Map(committed.categories),
          products: new Map(committed.products),
        }
        return { rows: [], rowCount: 0 }
      }

      if (sql === 'COMMIT') {
        committed.categories = tx.categories
        committed.products = tx.products
        tx = null
        return { rows: [], rowCount: 0 }
      }

      if (sql === 'ROLLBACK') {
        tx = null
        return { rows: [], rowCount: 0 }
      }

      if (sql.includes('to_regclass')) {
        return {
          rows: [
            project
              ? { categories: 'public.categories', products: 'public.products' }
              : { categories: null, products: null },
          ],
        }
      }

      if (
        sql.includes('FROM public.categories') &&
        sql.includes('WHERE slug = $1') &&
        sql.includes('sort_order')
      ) {
        const row = store().categories.get(params[0])
        return { rows: row ? [row] : [] }
      }

      if (sql.startsWith('INSERT INTO public.categories')) {
        store().categories.set(params[1], {
          name: params[0],
          slug: params[1],
          description: params[2],
          is_active: params[3],
          sort_order: params[4],
          id: `category-${params[1]}`,
        })
        return { rows: [], rowCount: 1 }
      }

      if (sql.includes('FROM public.categories') && sql.includes('SELECT id')) {
        const row = store().categories.get(params[0])
        return { rows: row ? [{ id: row.id }] : [] }
      }

      if (sql.includes('FROM public.products')) {
        const matches = [...store().products.values()].filter(
          (row) => row.slug === params[0] || row.sku === params[1],
        )
        return { rows: matches }
      }

      if (sql.startsWith('INSERT INTO public.products')) {
        if (failOnProductInsert) {
          throw new Error('insert failed')
        }

        store().products.set(params[2], {
          category_id: params[0],
          name: params[1],
          slug: params[2],
          description: params[3],
          product_type: params[4],
          sku: params[5],
          price_amount: params[6],
          currency: params[7],
          tax_status: params[8],
          vat_rate: params[9],
          is_active: params[10],
          stock_quantity: params[11],
          category_slug: [...store().categories.values()].find(
            (category) => category.id === params[0],
          )?.slug,
        })
        return { rows: [], rowCount: 1 }
      }

      throw new Error(`unexpected query: ${sql}`)
    },
    async release() {},
  }
}

describe('local catalog seed', () => {
  it('creates two categories and three products, then changes nothing', async () => {
    const client = createClient()
    const first = await seedLocalCatalog(client)
    const second = await seedLocalCatalog(client)

    assert.deepEqual(first, {
      insertedCategories: 2,
      insertedProducts: 3,
      unchangedCategories: 0,
      unchangedProducts: 0,
    })
    assert.deepEqual(second, {
      insertedCategories: 0,
      insertedProducts: 0,
      unchangedCategories: 2,
      unchangedProducts: 3,
    })
    assert.equal(client.committed.categories.size, 2)
    assert.equal(client.committed.products.size, 3)
    assert.equal(client.committed.categories.get('akcesoria').name, 'Akcesoria')
    assert.equal(
      client.committed.products.get('etui-ochronne').price_amount,
      4999,
    )
    assert.equal(client.committed.products.get('organizer').price_amount, 7900)
    assert.equal(
      client.committed.products.get('zestaw-podrozny').price_amount,
      12900,
    )
    assert.equal(
      client.committed.products.get('zestaw-podrozny').stock_quantity,
      3,
    )
    assert.equal(
      client.queries.some((sql) =>
        /shop_profile|customers|orders|payments|carts|inventory_reservations/.test(
          sql,
        ),
      ),
      false,
    )
  })

  it('rolls back when an existing category has different data', async () => {
    const client = createClient()
    client.committed.categories.set('akcesoria', {
      id: 'category-akcesoria',
      name: 'Inna nazwa',
      slug: 'akcesoria',
      description: null,
      is_active: true,
      sort_order: 1,
    })

    await assert.rejects(
      () => seedLocalCatalog(client),
      (error) =>
        error instanceof CatalogSeedError &&
        error.code === 'CATALOG_SEED_CONFLICT',
    )
    assert.equal(client.queries.at(-1), 'ROLLBACK')
    assert.equal(client.queries.includes('COMMIT'), false)
    assert.equal(client.committed.products.size, 0)
  })

  it('rolls back the whole transaction when an insert fails', async () => {
    const client = createClient({ failOnProductInsert: true })

    await assert.rejects(
      () => seedLocalCatalog(client),
      (error) =>
        error instanceof CatalogSeedError &&
        error.code === 'CATALOG_SEED_FAILED',
    )
    assert.equal(client.queries.at(-1), 'ROLLBACK')
    assert.equal(client.queries.includes('COMMIT'), false)
    assert.equal(client.committed.categories.size, 0)
    assert.equal(client.committed.products.size, 0)
  })

  it('refuses a database that is not the local project PostgreSQL', async () => {
    const refused = [
      'postgresql://postgres:postgres@db.example.supabase.co:5432/postgres',
      'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
      'postgresql://postgres:secret@127.0.0.1:54322/postgres',
      'postgresql://postgres:postgres@127.0.0.1:54322/other',
      'postgres://postgres:postgres@10.0.0.8:54322/postgres',
      '',
    ]

    for (const connectionString of refused) {
      assert.throws(
        () => assertLocalCatalogDatabase(connectionString),
        (error) =>
          error instanceof CatalogSeedError &&
          error.code === 'CATALOG_SEED_REFUSED',
      )
    }

    assert.doesNotThrow(() =>
      assertLocalCatalogDatabase(LOCAL_CATALOG_DATABASE_URL),
    )

    let connected = false
    await assert.rejects(
      () =>
        runLocalCatalogSeed({
          connectionString:
            'postgresql://postgres:postgres@db.example.supabase.co:5432/postgres',
          nodeEnv: 'development',
          connect() {
            connected = true
            throw new Error('connect should not be called')
          },
        }),
      (error) =>
        error instanceof CatalogSeedError &&
        error.code === 'CATALOG_SEED_REFUSED',
    )
    assert.equal(connected, false)

    await assert.rejects(
      () =>
        runLocalCatalogSeed({
          connectionString: LOCAL_CATALOG_DATABASE_URL,
          nodeEnv: 'production',
          connect() {
            connected = true
            return createClient()
          },
        }),
      (error) =>
        error instanceof CatalogSeedError &&
        error.code === 'CATALOG_SEED_REFUSED',
    )
    assert.equal(connected, false)
  })
})
