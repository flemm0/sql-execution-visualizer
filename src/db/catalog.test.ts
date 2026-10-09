import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadCatalog, postgresVersion, type DatabaseInfo, type TableInfo } from './catalog'
import { createDatabase } from './createDatabase'
import { seedDatabase } from './seed'

describe('catalog', () => {
  let db: Awaited<ReturnType<typeof createDatabase>>
  let catalog: DatabaseInfo
  let tables: TableInfo[]

  beforeAll(async () => {
    db = await createDatabase()
    await seedDatabase(db)
    catalog = await loadCatalog(db)
    tables = catalog.schemas.find((schema) => schema.name === 'public')?.tables ?? []
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

  it('shows the database and the public schema, hiding system schemas and the app\'s own', () => {
    expect(catalog.name).toBe('postgres')
    expect(catalog.schemas.map((schema) => schema.name)).toEqual(['public'])
  })

  it('lists columns in table order with their types, NOT NULL and primary key', () => {
    const orders = tables.find((table) => table.name === 'orders')
    expect(orders?.columns).toEqual([
      { name: 'id', type: 'integer', notNull: true, primaryKey: true },
      { name: 'customer_id', type: 'integer', notNull: true, primaryKey: false },
      { name: 'order_date', type: 'date', notNull: true, primaryKey: false },
      { name: 'status', type: 'text', notNull: true, primaryKey: false },
      { name: 'total', type: 'numeric(10,2)', notNull: true, primaryKey: false },
      { name: 'shipping_address', type: 'text', notNull: true, primaryKey: false },
    ])
    const orderItems = tables.find((table) => table.name === 'order_items')
    const keyColumns = orderItems?.columns.filter((column) => column.primaryKey).map((column) => column.name)
    expect(keyColumns).toEqual(['order_id', 'line_no'])
  })

  it('marks unique and primary key indexes', () => {
    const customers = tables.find((table) => table.name === 'customers')
    const flags = customers?.indexes.map((index) => [index.name, index.unique, index.primaryKey])
    expect(flags).toEqual([
      ['customers_email_key', true, false],
      ['customers_last_name_first_name_idx', false, false],
      ['customers_pkey', true, true],
    ])
  })

  it('reads B-tree depth from the index metapage with pageinspect', () => {
    const orderItems = tables.find((table) => table.name === 'order_items')
    expect(orderItems?.indexes).toEqual([
      expect.objectContaining({ name: 'order_items_pkey', levels: 3, definition: expect.stringContaining('(order_id, line_no)') }),
    ])
  })
})

describe('catalog after a learner changes the schema', () => {
  let db: Awaited<ReturnType<typeof createDatabase>>

  beforeAll(async () => {
    db = await createDatabase()
    await seedDatabase(db)
  }, 120_000)
  afterAll(() => db.close())

  it('shows new schemas (even empty ones), new tables, new indexes and dropped columns', async () => {
    await db.exec(`
      CREATE SCHEMA scratch;
      CREATE SCHEMA empty_one;
      CREATE TABLE scratch.notes (id bigint PRIMARY KEY, body varchar(200), gone int);
      ALTER TABLE scratch.notes DROP COLUMN gone;
      CREATE INDEX orders_status_idx ON orders (status);
    `)
    const catalog = await loadCatalog(db)
    expect(catalog.schemas.map((schema) => schema.name)).toEqual(['empty_one', 'public', 'scratch'])
    const notes = catalog.schemas.find((schema) => schema.name === 'scratch')?.tables[0]
    expect(notes?.name).toBe('notes')
    expect(notes?.columns.map((column) => `${column.name} ${column.type}`)).toEqual([
      'id bigint',
      'body character varying(200)',
    ])
    expect(notes?.indexes.map((index) => index.name)).toEqual(['notes_pkey'])
    const orders = catalog.schemas.find((schema) => schema.name === 'public')?.tables.find((t) => t.name === 'orders')
    expect(orders?.indexes.map((index) => index.name)).toContain('orders_status_idx')
  })

  it('includes each table\'s autovacuum counters, up to the statement that just ran', async () => {
    await db.exec(`UPDATE customers SET city = city WHERE id <= 300`)
    const catalog = await loadCatalog(db)
    const customers = catalog.schemas.find((schema) => schema.name === 'public')?.tables.find((t) => t.name === 'customers')
    expect(customers?.autovacuum?.activity.changedSinceAnalyze).toBe(300)
    // 10,000 rows: analyzed above 50 + 10%.
    expect(customers?.autovacuum?.assessment).toMatchObject({ changedRows: { count: 300, threshold: 1050 }, analyze: false })
  })
})
