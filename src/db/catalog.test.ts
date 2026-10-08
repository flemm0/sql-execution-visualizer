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

  it('reads B-tree depth from the index metapage with pageinspect', () => {
    const orderItems = tables.find((table) => table.name === 'order_items')
    expect(orderItems?.indexes).toEqual([
      expect.objectContaining({ name: 'order_items_pkey', levels: 3, definition: expect.stringContaining('(order_id, line_no)') }),
    ])
  })
})
