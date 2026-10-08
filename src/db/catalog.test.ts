import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listTables, postgresVersion, type TableInfo } from './catalog'
import { createDatabase } from './createDatabase'
import { seedDatabase } from './seed'

describe('catalog', () => {
  let db: Awaited<ReturnType<typeof createDatabase>>
  let tables: TableInfo[]

  beforeAll(async () => {
    db = await createDatabase()
    await seedDatabase(db)
    tables = await listTables(db)
  }, 120_000)
  afterAll(() => db.close())

  it('runs Postgres 18', async () => {
    expect(await postgresVersion(db)).toMatch(/^PostgreSQL 18\./)
  })

  it('lists the seeded tables with their sizes', () => {
    expect(tables.map((table) => table.name)).toEqual(['categories', 'customers', 'order_items', 'orders', 'products'])
    const categories = tables.find((table) => table.name === 'categories')
    expect(categories).toMatchObject({ estimatedRows: 12, pages: 1, sizeBytes: 8192 })
  })

  it('matches the sizes measured in DATA.md', () => {
    // If this fails after an intentional change to the seed, update the table in docs/DATA.md.
    const sizes = tables.map((table) => ({
      table: table.name,
      heapPages: table.pages,
      // Written as in DATA.md: name (pages, B-tree levels).
      indexes: table.indexes.map((index) => `${index.name} (${index.pages}, ${index.levels})`),
    }))
    expect(sizes).toEqual([
      { table: 'categories', heapPages: 1, indexes: ['categories_pkey (2, 1)'] },
      {
        table: 'customers',
        heapPages: 126,
        indexes: [
          'customers_email_key (64, 2)',
          'customers_last_name_first_name_idx (40, 2)',
          'customers_pkey (30, 2)',
        ],
      },
      { table: 'order_items', heapPages: 1278, indexes: ['order_items_pkey (553, 3)'] },
      {
        table: 'orders',
        heapPages: 589,
        indexes: ['orders_customer_id_order_date_idx (139, 2)', 'orders_pkey (139, 2)'],
      },
      { table: 'products', heapPages: 48, indexes: ['products_pkey (5, 2)'] },
    ])
  })

  it('reads B-tree depth from the index metapage with pageinspect', () => {
    const orderItems = tables.find((table) => table.name === 'order_items')
    expect(orderItems?.indexes).toEqual([
      expect.objectContaining({ name: 'order_items_pkey', levels: 3, definition: expect.stringContaining('(order_id, line_no)') }),
    ])
  })
})
