import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushStatistics } from './autovacuum'
import { createDatabase } from './createDatabase'
import { SEED_VERSION, readSeedInfo, resetDatabase, seedDatabase } from './seed'

type Database = Awaited<ReturnType<typeof createDatabase>>

async function count(db: Database, sql: string) {
  const result = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return result.rows[0].n
}

/** A hash of every seeded row and its ctid, so it also covers the physical page layout. */
async function fingerprint(db: Database) {
  const tables = ['categories', 'products', 'customers', 'orders', 'order_items']
  const parts = tables.map((table) => `(SELECT string_agg(ctid || t::text, '|' ORDER BY ctid) FROM ${table} AS t)`)
  const result = await db.query<{ md5: string }>(`SELECT md5(${parts.join(' || ')}) AS md5`)
  return result.rows[0].md5
}

const SEED_FINGERPRINT = '68e51b9d652ae979503b9182676b0016'

describe('seed data', () => {
  let db: Database

  beforeAll(async () => {
    db = await createDatabase()
    const started = performance.now()
    await seedDatabase(db)
    console.log(`Seeding took ${Math.round(performance.now() - started)} ms`)
  }, 120_000)
  afterAll(() => db.close())

  it('records the seed version', async () => {
    expect((await readSeedInfo(db))?.version).toBe(SEED_VERSION)
  })

  it('creates the tables with the documented row counts', async () => {
    expect(await count(db, 'SELECT count(*) FROM categories')).toBe(12)
    expect(await count(db, 'SELECT count(*) FROM products')).toBe(1000)
    expect(await count(db, 'SELECT count(*) FROM customers')).toBe(10000)
    expect(await count(db, 'SELECT count(*) FROM orders')).toBe(50000)
    expect(await count(db, 'SELECT count(*) FROM order_items')).toBe(200_582)
  })

  it('stores orders physically in date order', async () => {
    // Index range scans on id or order_date touch few pages only if this holds.
    const correlation = await db.query<{ correlation: number }>(
      `SELECT correlation FROM pg_stats WHERE tablename = 'orders' AND attname = 'order_date'`,
    )
    expect(correlation.rows[0].correlation).toBeGreaterThan(0.99)
  })

  it('makes order status lopsided, with the newest orders not yet delivered', async () => {
    const share = async (status: string) =>
      (await count(db, `SELECT count(*) FROM orders WHERE status = '${status}'`)) / 50000
    expect(await share('delivered')).toBeCloseTo(0.9, 1)
    expect(await share('pending')).toBeCloseTo(0.03, 2)
    expect(await share('shipped')).toBeCloseTo(0.05, 2)
    expect(await share('cancelled')).toBeCloseTo(0.02, 2)
    expect(await count(db, `SELECT max(id) FROM orders WHERE status = 'delivered'`)).toBeLessThan(46000)
  })

  it('makes about 40% of customers American', async () => {
    const us = await count(db, `SELECT count(*) FROM customers WHERE country = 'United States'`)
    expect(us / 10000).toBeCloseTo(0.4, 1)
  })

  it('repeats last names, so a name lookup returns tens of rows', async () => {
    const smiths = await count(db, `SELECT count(*) FROM customers WHERE last_name = 'Smith'`)
    expect(smiths).toBeGreaterThan(20)
    expect(smiths).toBeLessThan(100)
  })

  it('creates only the documented indexes', async () => {
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'categories_pkey',
      'customers_email_key',
      'customers_last_name_first_name_idx',
      'customers_pkey',
      'order_items_pkey',
      'orders_customer_id_order_date_idx',
      'orders_pkey',
      'products_pkey',
    ])
  })

  it('gives the big table a 3-level B-tree', async () => {
    const meta = await db.query<{ level: number }>(`SELECT level FROM bt_metap('order_items_pkey')`)
    // The metapage counts leaves as level 0.
    expect(meta.rows[0].level + 1).toBe(3)
  })

  it('leaves every page all-visible after VACUUM', async () => {
    const tables = await db.query<{ relname: string; relpages: number; relallvisible: number }>(
      `SELECT relname, relpages, relallvisible FROM pg_class
       WHERE relname IN ('categories', 'products', 'customers', 'orders', 'order_items')`,
    )
    for (const table of tables.rows) expect(table.relallvisible, table.relname).toBe(table.relpages)
  })

  it('leaves the autovacuum counters as a real VACUUM ANALYZE would', async () => {
    await flushStatistics(db)
    const stats = await db.query<{ live: number; changed: number; inserted: number }>(
      `SELECT n_live_tup::int AS live, n_mod_since_analyze::int AS changed, n_ins_since_vacuum::int AS inserted
       FROM pg_stat_user_tables WHERE relname = 'orders'`,
    )
    expect(stats.rows[0]).toEqual({ live: 50000, changed: 0, inserted: 0 })
  })

  it('continues identity columns after the generated ids', async () => {
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO categories (name, description) VALUES ('Test', 'Test') RETURNING id`,
    )
    expect(inserted.rows[0].id).toBe(13)
    await db.exec(`DELETE FROM categories WHERE id = 13`)
  })

  it('generates identical data every time', async () => {
    // If this fails after an intentional change to the generator, bump SEED_VERSION
    // in seed.ts and update SEED_FINGERPRINT above.
    expect(await fingerprint(db)).toBe(SEED_FINGERPRINT)
  })

  it('publishes the insert counts before VACUUM ANALYZE, so they can\'t land on top of it afterwards', async () => {
    // The check above only fails when the seed finishes within a second of Postgres's
    // last statistics flush, so this one checks the order of the calls directly.
    const fresh = await createDatabase()
    const query = vi.spyOn(fresh, 'query')
    const exec = vi.spyOn(fresh, 'exec')
    await seedDatabase(fresh)
    const calls = [
      ...query.mock.calls.map(([sql], index) => ({ sql, order: query.mock.invocationCallOrder[index] })),
      ...exec.mock.calls.map(([sql], index) => ({ sql, order: exec.mock.invocationCallOrder[index] })),
    ]
      .sort((a, b) => a.order - b.order)
      .map((call) => call.sql)
    const seeded = calls.findIndex((sql) => sql.includes('COMMIT'))
    const flushed = calls.findIndex((sql) => sql.includes('pg_stat_force_next_flush()'))
    const vacuumed = calls.findIndex((sql) => sql.startsWith('VACUUM ANALYZE'))
    expect(seeded).toBeGreaterThanOrEqual(0)
    expect(flushed).toBeGreaterThan(seeded)
    expect(vacuumed).toBeGreaterThan(flushed)
    await fresh.close()
  }, 120_000)

  it('reset drops learner changes and restores the seed', async () => {
    await db.exec(`
      CREATE INDEX ON order_items (product_id);
      CREATE SCHEMA scratch;
      CREATE TABLE scratch.notes (body text);
      DELETE FROM order_items WHERE order_id = 1;
    `)
    await resetDatabase(db)
    expect(await count(db, `SELECT count(*) FROM pg_indexes WHERE tablename = 'order_items'`)).toBe(1)
    expect(await count(db, `SELECT count(*) FROM pg_namespace WHERE nspname = 'scratch'`)).toBe(0)
    expect(await count(db, 'SELECT count(*) FROM order_items WHERE order_id = 1')).toBeGreaterThan(0)
    expect(await count(db, `SELECT count(*) FROM pg_extension WHERE extname = 'pageinspect'`)).toBe(1)
    expect((await readSeedInfo(db))?.version).toBe(SEED_VERSION)
    expect(await fingerprint(db)).toBe(SEED_FINGERPRINT)
  }, 120_000)
})
