import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import { cachedBlocks, findRelations, snapshotCache } from './inspector'
import {
  MAX_DISPLAYED_ROWS,
  runAll,
  runStatementAt,
  transactionStatus,
  type RunOptions,
  type StatementResult,
} from './runner'
import { seedDatabase } from './seed'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
}, 120_000)
afterAll(() => db.close())

/** Narrows a result to one status, failing the test with the actual result otherwise. */
function expectStatus<S extends StatementResult['status']>(result: StatementResult, status: S) {
  expect(result, JSON.stringify(result, null, 2).slice(0, 500)).toMatchObject({ status })
  return result as Extract<StatementResult, { status: S }>
}

async function runOne(sql: string, options: RunOptions = {}) {
  const [result] = await runStatementAt(db, sql, 0, options)
  return result
}

describe('running the statement under the cursor', () => {
  it('runs only that statement', async () => {
    const sql = 'SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;'
    const results = await runStatementAt(db, sql, sql.indexOf('2'))
    expect(results).toHaveLength(1)
    const result = expectStatus(results[0], 'rows')
    expect(result.columns).toEqual(['b'])
    expect(result.rows).toEqual([['2']])
  })

  it('returns nothing for an editor with no statements', async () => {
    expect(await runStatementAt(db, '-- nothing yet', 0)).toEqual([])
  })
})

describe('a query', () => {
  it('returns Postgres’s own text for each value, and NULL as null', async () => {
    const result = expectStatus(
      await runOne(`SELECT id, order_date, total, NULL AS nothing, true AS yes FROM orders WHERE id = 4242`),
      'rows',
    )
    expect(result.columns).toEqual(['id', 'order_date', 'total', 'nothing', 'yes'])
    const [row] = result.rows
    expect(row[0]).toBe('4242')
    // A date stays a date: not converted to a JavaScript Date in some time zone.
    expect(row[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(row[2]).toMatch(/^\d+\.\d{2}$/)
    expect(row.slice(3)).toEqual([null, 't'])
  })

  it('comes with its real plan, including actual rows and buffer counts', async () => {
    const result = expectStatus(await runOne('SELECT * FROM orders WHERE id = 4242'), 'rows')
    const plan = result.plan
    expect(plan).not.toBeNull()
    expect(plan?.root.title).toBe('Index Scan using orders_pkey on orders')
    expect(plan?.root.estimatedRows).toBe(1)
    expect(plan?.root.actualRows).toBe(1)
    expect(plan?.root.loops).toBe(1)
    expect((plan?.root.sharedHit ?? 0) + (plan?.root.sharedRead ?? 0)).toBeGreaterThan(0)
    expect(plan?.root.details).toContainEqual({ label: 'Index Cond', value: '(orders.id = 4242)' })
    expect(plan?.executionMs).toBeGreaterThanOrEqual(0)
  })

  it('shows a plan that changes when an index is created', async () => {
    const query = 'SELECT * FROM order_items WHERE product_id = 42'
    const before = expectStatus(await runOne(query), 'rows')
    expect(before.plan?.root.nodeType).toBe('Seq Scan')
    expect(before.plan?.root.details.map((detail) => detail.label)).toContain('Rows Removed by Filter')

    await runOne('CREATE INDEX order_items_product_id_idx ON order_items (product_id)')
    const after = expectStatus(await runOne(query), 'rows')
    const titles = [after.plan?.root.title, ...(after.plan?.root.children ?? []).map((child) => child.title)]
    expect(titles.join(' / ')).toContain('order_items_product_id_idx')
    // The same rows either way.
    expect(after.totalRows).toBe(before.totalRows)

    await runOne('DROP INDEX order_items_product_id_idx')
  })

  it('shows at most 1,000 rows but reports the total', async () => {
    const result = expectStatus(await runOne('SELECT * FROM order_items'), 'rows')
    const total = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM order_items')
    expect(result.rows).toHaveLength(MAX_DISPLAYED_ROWS)
    expect(result.totalRows).toBe(total.rows[0].count)
  })

  it('runs a statement that writes inside WITH only once, without a plan', async () => {
    await runOne('CREATE TABLE once (n int)')
    const result = expectStatus(await runOne('WITH added AS (INSERT INTO once VALUES (1) RETURNING n) SELECT * FROM added'), 'rows')
    expect(result.plan).toBeNull()
    const count = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM once')
    expect(count.rows[0].count).toBe(1)
    await runOne('DROP TABLE once')
  })
})

describe('the cache a query starts with', () => {
  /** The plan's buffer counts for its top node, which include its children's. */
  async function buffers(sql: string, options: RunOptions) {
    const result = expectStatus(await runOne(sql, options), 'rows')
    return { hit: result.plan?.root.sharedHit, read: result.plan?.root.sharedRead }
  }

  it('is emptied of the query’s tables and indexes when asked, so every page is read (example 1)', async () => {
    const sql = 'SELECT * FROM orders WHERE id = 4242'
    // The B-tree root, one leaf and one heap page.
    expect(await buffers(sql, { emptyCache: true })).toEqual({ hit: 0, read: 3 })
    expect(await buffers(sql, { emptyCache: true })).toEqual({ hit: 0, read: 3 })
    expect(await buffers(sql, {})).toEqual({ hit: 3, read: 0 })
  })

  it('is emptied through a view, of the tables underneath', async () => {
    await runOne('CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 900')
    const result = expectStatus(await runOne('SELECT count(*) FROM big_orders', { emptyCache: true }), 'rows')
    expect(result.cache?.emptied).toBe(true)
    expect(result.cache?.relations.map((relation) => relation.name)).toEqual([
      'orders',
      'orders_customer_id_order_date_idx',
      'orders_pkey',
    ])
    expect(result.cache?.before.pages).toEqual([])
    expect(result.plan?.root.sharedHit).toBe(0)
    await runOne('DROP VIEW big_orders')
  })

  it('is snapshotted after planning, which can read index pages of its own', async () => {
    // Without these the planner picks a Bitmap Heap Scan.
    await db.exec('SET enable_bitmapscan = off; SET enable_seqscan = off')
    // 1 is the lowest customer_id, so the planner probes the index for the real minimum.
    const sql = 'SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100'
    const result = expectStatus(await runOne(sql, { emptyCache: true }), 'rows')
    await db.exec('RESET enable_bitmapscan; RESET enable_seqscan')

    const [orders] = result.cache?.relations ?? []
    const index = result.cache?.relations.find((relation) => relation.name === 'orders_customer_id_order_date_idx')
    if (!result.plan || !result.cache || !orders || !index) throw new Error('no plan or cache')
    const probed = cachedBlocks(result.cache.before, index)
    expect(probed.size).toBeGreaterThan(0)
    // The plan reports the planning that read them, not EXPLAIN ANALYZE's own (which found them cached).
    expect(result.plan.planningRead).toBeGreaterThanOrEqual(probed.size)

    // Execution finds the probed index pages cached: hits, not reads. Heap pages
    // count once each time the scan moves to another page (ADR 0022).
    const scannedIndexPages = cachedBlocks(await snapshotCache(db, [index]), index).size
    const rows = await db.query<{ page: number }>(
      `SELECT (ctid::text::point)[0]::int AS page FROM orders WHERE customer_id BETWEEN 1 AND 100
       ORDER BY customer_id, order_date, ctid`,
    )
    const heap = { hit: 0, read: 0 }
    const seen = new Set(cachedBlocks(result.cache.before, orders))
    rows.rows.forEach((row, i) => {
      if (i > 0 && rows.rows[i - 1].page === row.page) return
      if (seen.has(row.page)) heap.hit++
      else heap.read++
      seen.add(row.page)
    })
    expect(result.plan.root).toMatchObject({
      sharedHit: heap.hit + probed.size,
      sharedRead: heap.read + scannedIndexPages - probed.size,
    })
  })

  it('is left as it is by default, and snapshotted with the pages already cached', async () => {
    const sql = 'SELECT * FROM categories WHERE id = 3'
    await runOne(sql)
    const result = expectStatus(await runOne(sql), 'rows')
    expect(result.cache?.emptied).toBe(false)
    const [categories] = await findRelations(db, [{ schema: 'public', name: 'categories' }])
    expect(result.cache && cachedBlocks(result.cache.before, categories)).toEqual(new Set([0]))
    expect(result.plan?.root).toMatchObject({ sharedHit: 1, sharedRead: 0 })
  })

  it('is not looked at for a query that reads no table', async () => {
    const result = expectStatus(await runOne('SELECT 1', { emptyCache: true }), 'rows')
    expect(result.cache).toEqual({ relations: [], emptied: true, before: { pages: [] } })
  })
})

describe('other statements', () => {
  it('report done, with the number of rows changed by writes', async () => {
    expectStatus(await runOne('CREATE TABLE notes (id int, body text)'), 'done')
    const insert = expectStatus(await runOne(`INSERT INTO notes VALUES (1, 'a'), (2, 'b')`), 'done')
    expect(insert.command).toBe('INSERT')
    expect(insert.affectedRows).toBe(2)
    const update = expectStatus(await runOne(`UPDATE notes SET body = 'c' WHERE id = 2`), 'done')
    expect(update.affectedRows).toBe(1)
    const vacuum = expectStatus(await runOne('VACUUM notes'), 'done')
    expect(vacuum.affectedRows).toBeNull()
    const drop = expectStatus(await runOne('DROP TABLE notes'), 'done')
    expect(drop.command).toBe('DROP TABLE')
  })

  it('pass on Postgres’s notices', async () => {
    const drop = expectStatus(await runOne('DROP TABLE IF EXISTS never_created'), 'done')
    expect(drop.notices).toEqual(['NOTICE: table "never_created" does not exist, skipping'])
  })

  it('return rows when they have any, without a plan', async () => {
    const result = expectStatus(await runOne('SHOW block_size'), 'rows')
    expect(result.rows).toEqual([['8192']])
    expect(result.plan).toBeNull()
  })
})

describe('errors', () => {
  it('carry Postgres’s message and the position in the editor text', async () => {
    const sql = 'SELECT 1;\nSELECT * FROM nope;'
    const [result] = await runStatementAt(db, sql, sql.indexOf('nope'))
    const error = expectStatus(result, 'error')
    expect(error.message).toBe('relation "nope" does not exist')
    expect(error.position).toBe(sql.indexOf('nope'))
  })

  it('carry Postgres’s DETAIL, HINT and SQLSTATE code', async () => {
    const duplicate = expectStatus(await runOne(`INSERT INTO categories VALUES (1, 'again', 'again')`), 'error')
    expect(duplicate.message).toBe('duplicate key value violates unique constraint "categories_pkey"')
    expect(duplicate.detail).toBe('Key (id)=(1) already exists.')
    expect(duplicate.code).toBe('23505')

    const noFunction = expectStatus(await runOne('SELECT lower(1)'), 'error')
    expect(noFunction.hint).toContain('explicit type casts')
  })

  it('stop Run all; the statements after the error are skipped', async () => {
    const results = await runAll(db, 'CREATE TABLE t1 (a int);\nINSERT INTO missing VALUES (1);\nDROP TABLE t1;')
    expect(results.map((result) => result.status)).toEqual(['done', 'error', 'skipped'])
    const exists = await db.query(`SELECT to_regclass('t1') IS NOT NULL AS found`)
    expect(exists.rows).toEqual([{ found: true }])
    await db.exec('DROP TABLE t1')
  })
})

describe('errors inside a transaction block', () => {
  // Even when a test fails partway, leave no transaction open for the next one.
  afterEach(async () => {
    if ((await transactionStatus(db)) !== 'I') await db.exec('ROLLBACK')
  })

  it('carry the real message and position, not "current transaction is aborted"', async () => {
    const sql = 'BEGIN;\nSELECT * FROM nope;'
    const results = await runAll(db, sql)
    expect(results.map((result) => result.status)).toEqual(['done', 'error'])
    const error = expectStatus(results[1], 'error')
    expect(error.message).toBe('relation "nope" does not exist')
    expect(error.code).toBe('42P01')
    expect(error.position).toBe(sql.indexOf('nope'))
    // The statement itself failed, so the transaction has too, as in psql.
    expect(await transactionStatus(db)).toBe('E')
  })

  it('carry the real message for an error only execution reaches', async () => {
    const results = await runAll(db, 'BEGIN;\nSELECT 1 / (id - 4242) FROM orders;')
    const error = expectStatus(results[1], 'error')
    expect(error.message).toBe('division by zero')
  })

  it('leave the transaction usable once the visitor rolls back to their savepoint', async () => {
    const first = await runAll(db, 'BEGIN;\nCREATE TABLE kept (n int);\nSAVEPOINT before_error;\nSELECT * FROM nope;')
    expect(first.map((result) => result.status)).toEqual(['done', 'done', 'done', 'error'])

    const second = await runAll(db, 'ROLLBACK TO SAVEPOINT before_error;\nSELECT count(*) AS n FROM kept;')
    expect(second.map((result) => result.status)).toEqual(['done', 'rows'])
    // A query in a transaction block still gets its plan.
    expect(expectStatus(second[1], 'rows').plan?.root.nodeType).toBe('Aggregate')
    expect(await transactionStatus(db)).toBe('T')
  })

  it('in a transaction block that already failed, report it as Postgres does', async () => {
    await runAll(db, 'BEGIN;\nSELECT * FROM nope;')
    const [result] = await runAll(db, 'SELECT 1;')
    expect(expectStatus(result, 'error').message).toBe(
      'current transaction is aborted, commands ignored until end of transaction block',
    )
  })
})
