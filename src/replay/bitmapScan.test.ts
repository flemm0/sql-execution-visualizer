import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { findRelations } from '../db/inspector'
import { parsePlan, tablesInPlan } from '../db/plan'
import { runStatementAt, type RowsResult, type RunOptions } from '../db/runner'
import { seedDatabase } from '../db/seed'
import { bitmapPages } from './bitmapScan'
import { LOSSY_REASON, prepareReplay, type Replay } from './replay'
import type { Trace, TraceEvent } from './trace'

/*
 * Bitmap Heap Scan replays. A database of its own: example 3 adds an index
 * on order_items, which changes the plans other replay tests count on.
 */

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
}, 120_000)
afterAll(() => db.close())

async function run(sql: string, options: RunOptions = { emptyCache: true }): Promise<RowsResult> {
  const [result] = await runStatementAt(db, sql, 0, options)
  if (result.status !== 'rows') throw new Error(`${sql}: ${JSON.stringify(result).slice(0, 300)}`)
  return result
}

/** The replay of a query that must replay, failing the test with its validation otherwise. */
async function replayed(sql: string, options?: RunOptions) {
  const result = await run(sql, options)
  const replay = result.replay as Replay
  expect(replay.status, JSON.stringify(replay).slice(0, 500)).toBe('replayed')
  if (replay.status !== 'replayed') throw new Error('not replayed')
  const failed = replay.validation.checks.filter((check) => !check.ok)
  expect(failed, `${sql}: ${JSON.stringify(replay.validation.notes)}`).toEqual([])
  return { result, trace: replay.trace, validation: replay.validation }
}

/** The replay of a query that must replay as a Bitmap Heap Scan over a Bitmap Index Scan. */
async function bitmapReplay(sql: string, options?: RunOptions) {
  const replay = await replayed(sql, options)
  expect(replay.result.plan?.root.nodeType).toBe('Bitmap Heap Scan')
  expect(replay.result.plan?.root.children.map((child) => child.nodeType)).toEqual(['Bitmap Index Scan'])
  return replay
}

function ofType<T extends TraceEvent['type']>(trace: Trace, type: T) {
  return trace.events.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type)
}

function text(row: { block: number; offset: number }) {
  return `(${row.block},${row.offset})`
}

async function ctidsOf(sql: string) {
  const result = await db.query<{ ctid: string }>(sql)
  return result.rows.map((row) => row.ctid)
}

/** The heap pages a node asked for, in order: [block, 'hit' or 'read']. */
function heapAccesses(trace: Trace, node: number) {
  const tables = new Set(trace.relations.filter((relation) => relation.kind === 'table').map((relation) => relation.id))
  return trace.events.flatMap((event) =>
    (event.type === 'buffer.hit' || event.type === 'buffer.read') && event.node === node && tables.has(event.page.relation)
      ? [[event.page.block, event.type === 'buffer.hit' ? 'hit' : 'read'] as const]
      : [],
  )
}

/** Runs `body` with some of the planner's choices turned off, so it picks the plan a test is about. */
async function without<T>(settings: string[], body: () => Promise<T>): Promise<T> {
  await db.exec(settings.map((setting) => `SET ${setting} = off;`).join(' '))
  try {
    return await body()
  } finally {
    await db.exec(settings.map((setting) => `RESET ${setting};`).join(' '))
  }
}

describe('the pages a bitmap marks', () => {
  it('go in physical order, each page once, its rows in line pointer order, each once', () => {
    const tids = [
      { block: 7, offset: 3 },
      { block: 2, offset: 9 },
      { block: 7, offset: 1 },
      { block: 2, offset: 4 },
      { block: 7, offset: 3 },
    ]
    expect(bitmapPages(tids)).toEqual([
      { block: 2, offsets: [4, 9] },
      { block: 7, offsets: [1, 3] },
    ])
    expect(bitmapPages([])).toEqual([])
  })
})

describe('replaying a Bitmap Heap Scan', () => {
  const example6 = 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300'

  it('example 6: the index scan marks 944 rows in a bitmap; then each of their 480 heap pages is read once, in physical order', async () => {
    const { result, trace, validation } = await bitmapReplay(example6)
    const [heapScan, indexScan] = [result.plan?.root, result.plan?.root.children[0]]
    expect(heapScan?.title).toBe('Bitmap Heap Scan on orders')
    expect(indexScan?.title).toBe('Bitmap Index Scan on orders_customer_id_order_date_idx')

    // The Bitmap Heap Scan starts, has its child build the whole bitmap, then reads the heap.
    expect(trace.events.slice(0, 3)).toEqual([
      { type: 'node.start', node: 0 },
      { type: 'node.start', node: 1 },
      { type: 'index.search', node: 1, index: expect.any(Number) },
    ])
    const types = trace.events.map((event) => event.type)
    const handOver = trace.events.findIndex((event) => event.type === 'node.finish' && event.node === 1)
    expect(trace.events.slice(0, handOver).every((event) => event.node === 1 || event.type === 'node.start')).toBe(true)
    expect(trace.events.slice(handOver + 1).every((event) => event.node === 0)).toBe(true)
    expect(trace.events.at(-1)).toEqual({ type: 'node.finish', node: 0 })

    // The index scan fetches nothing and marks nothing dead: every match goes into the bitmap.
    const entries = ofType(trace, 'index.entry')
    expect(entries).toHaveLength(944)
    expect(entries.every((entry) => entry.node === 1 && entry.bitmap === true)).toBe(true)
    expect(types).not.toContain('index.markDead')
    expect(ofType(trace, 'heap.tuple').every((event) => event.node === 0)).toBe(true)

    // Each heap page the bitmap marks, once, in physical order: 480 reads.
    const marked = [...new Set(entries.map((entry) => entry.row.block))].sort((a, b) => a - b)
    expect(marked).toHaveLength(480)
    expect(heapAccesses(trace, 0)).toEqual(marked.map((block) => [block, 'read']))

    // On each page, its marked rows in line pointer order; all visible, all sent to the result.
    const rows = await ctidsOf(`SELECT ctid::text FROM orders WHERE customer_id BETWEEN 100 AND 300 ORDER BY orders.ctid`)
    expect(ofType(trace, 'heap.tuple').map((event) => text(event.row))).toEqual(rows)
    expect(ofType(trace, 'row.emit').map((event) => text(event.row))).toEqual(rows)
    expect(ofType(trace, 'row.emit').map((event) => event.resultIndex)).toEqual([...Array(944).keys()])

    expect(validation.checks.map((check) => check.label)).toEqual([
      'Bitmap Heap Scan on orders: rows',
      'Bitmap Heap Scan on orders: exact heap blocks',
      'Bitmap Heap Scan on orders: buffer hits',
      'Bitmap Heap Scan on orders: buffer reads',
      'Bitmap Index Scan on orders_customer_id_order_date_idx: rows',
      'Bitmap Index Scan on orders_customer_id_order_date_idx: index searches',
      'Bitmap Index Scan on orders_customer_id_order_date_idx: buffer hits',
      'Bitmap Index Scan on orders_customer_id_order_date_idx: buffer reads',
      'Result: rows',
      'Result: rows with the same values, in the same order',
    ])
    expect(validation.checks.find((check) => check.label.endsWith('exact heap blocks'))).toMatchObject({ postgres: 480, replay: 480 })
    // The trace carries the index pages it walked, for the B-tree view.
    expect(trace.indexPages.length).toBeGreaterThan(0)
  })

  it('walks the Bitmap Index Scan’s index before the query runs, as for an index scan', async () => {
    const explained = await db.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (VERBOSE, FORMAT JSON) ${example6}`)
    const json = explained.rows[0]['QUERY PLAN']
    const prepared = await prepareReplay(db, parsePlan(json), await findRelations(db, tablesInPlan(json)))
    expect(prepared).toMatchObject({ status: 'walked', walk: { indexName: 'orders_customer_id_order_date_idx' }, visibilityMap: null })
  })

  it('example 6 with a warm cache: every page is a hit', async () => {
    await run(example6, {})
    const { trace } = await bitmapReplay(example6, {})
    expect(ofType(trace, 'buffer.read')).toEqual([])
    expect(heapAccesses(trace, 0).every(([, access]) => access === 'hit')).toBe(true)
  })

  it('example 12: where an Index Scan goes back to heap pages it read before, the bitmap scan reads each of them once', async () => {
    const scattered = 'SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100'
    const bitmap = await bitmapReplay(scattered)
    const pages = heapAccesses(bitmap.trace, 0)
    expect(pages).toHaveLength(312)
    expect(pages.every(([, access]) => access === 'read')).toBe(true)
    expect(ofType(bitmap.trace, 'row.emit')).toHaveLength(468)

    // The same rows in index order: 468 rows over the same 312 pages, back and forth (ADR 0022).
    const indexScan = await without(['enable_bitmapscan', 'enable_seqscan'], () => replayed(scattered))
    expect(indexScan.result.plan?.root.nodeType).toBe('Index Scan')
    const indexOrder = heapAccesses(indexScan.trace, 0)
    expect(indexOrder.filter(([, access]) => access === 'read')).toHaveLength(312)
    expect(indexOrder.filter(([, access]) => access === 'hit')).toHaveLength(154)

    // Its other half: the same number of rows in id order, which is the table's order, is an Index Scan of a few pages.
    const clustered = await replayed('SELECT * FROM orders WHERE id BETWEEN 1 AND 500')
    expect(clustered.result.plan?.root.nodeType).toBe('Index Scan')
    expect(heapAccesses(clustered.trace, 0)).toHaveLength(6)
  })

  it('example 3: once order_items has an index on product_id, example 2 reads 177 heap pages instead of all 1,278', async () => {
    await db.exec('CREATE INDEX ON order_items (product_id)')
    const { result, trace } = await bitmapReplay('SELECT * FROM order_items WHERE product_id = 42')
    expect(result.plan?.root.children[0].title).toBe('Bitmap Index Scan on order_items_product_id_idx')
    expect(result.totalRows).toBe(189)
    expect(heapAccesses(trace, 0)).toHaveLength(177)
  })

  it('checks the Filter on the rows it can see, and counts the ones that fail as removed', async () => {
    const { result, trace, validation } = await bitmapReplay(`${example6} AND total > 100`)
    const failed = ofType(trace, 'heap.tuple').filter((event) => !event.matched)
    expect(failed.length).toBeGreaterThan(0)
    expect(validation.checks.find((check) => check.label === 'Bitmap Heap Scan on orders: rows removed by filter')).toMatchObject({
      postgres: failed.length,
      replay: failed.length,
    })
    // The index scan marks every row in its range; the Filter is checked on the heap.
    expect(ofType(trace, 'index.entry')).toHaveLength(944)
    expect(result.totalRows).toBe(944 - failed.length)
  })

  it('checks each marked row: a deleted one isn’t visible, an UPDATE’s old version neither, and a HOT update leads to the new version', async () => {
    await db.exec(`
      CREATE TABLE stock (id int PRIMARY KEY, count int, note text) WITH (fillfactor = 50, autovacuum_enabled = off);
      CREATE INDEX ON stock (count);
      INSERT INTO stock SELECT n, 0, 'n' FROM generate_series(1, 500) AS n;
      UPDATE stock SET count = 1 WHERE id BETWEEN 10 AND 12; -- count is indexed: new versions, new entries
      UPDATE stock SET note = 'changed' WHERE id = 14; -- HOT: the entry still leads to the row
      DELETE FROM stock WHERE id = 20;
    `)
    const sql = 'SELECT * FROM stock WHERE id BETWEEN 8 AND 22'
    const { result, trace } = await without(['enable_seqscan', 'enable_indexscan'], () => bitmapReplay(sql))
    expect(result.totalRows).toBe(14)
    const tuples = ofType(trace, 'heap.tuple')
    // 15 ids, and 3 of them twice: the old version's entry and the new one's.
    expect(tuples).toHaveLength(18)
    expect(tuples.filter((event) => event.visible === null)).toHaveLength(4)
    const moved = tuples.filter((event) => event.visible !== null && text(event.visible) !== text(event.row))
    expect(moved).toHaveLength(1)
    // Rows go to the result as the bitmap orders them, by the line pointer the index points at.
    const emitted = ofType(trace, 'row.emit').map((event) => text(event.row))
    expect(emitted).toContain(text(moved[0].visible as { block: number; offset: number }))
    expect(emitted).not.toEqual([...emitted].sort())

    // Inside a transaction block: the visitor's own uncommitted delete hides the row.
    await db.exec('BEGIN; DELETE FROM stock WHERE id = 9')
    const inside = await without(['enable_seqscan', 'enable_indexscan'], () => bitmapReplay(sql))
    await db.exec('ROLLBACK')
    expect(inside.result.totalRows).toBe(13)
    await db.exec('DROP TABLE stock')
  })

  it('a list of values: the Bitmap Index Scan searches the index once per value it can’t reach by reading on', async () => {
    const { result, trace } = await bitmapReplay('SELECT * FROM orders WHERE customer_id IN (5, 500, 5000, 7000)')
    expect(result.plan?.root.children[0].indexSearches).toBe(4)
    expect(ofType(trace, 'index.search')).toHaveLength(4)
    expect(result.totalRows).toBe(ofType(trace, 'row.emit').length)
  })

  it('a skip scan: its first run in a session explains the system catalog pages Postgres counts; the next matches', async () => {
    const sql = `SELECT * FROM orders WHERE order_date = '2023-06-01'`
    const first = await run(sql)
    if (first.replay?.status !== 'replayed') throw new Error('not replayed')
    expect(first.plan?.root.nodeType).toBe('Bitmap Heap Scan')
    expect(first.replay.validation.checks.filter((check) => !check.ok).every((check) => check.label.endsWith('buffer hits'))).toBe(true)
    const { trace } = await bitmapReplay(sql)
    expect(ofType(trace, 'index.entry')).toHaveLength(45)
  })
})

describe('a bitmap scan the replay engine can’t replay yet', () => {
  async function reason(sql: string) {
    const replay = (await run(sql)).replay
    return replay?.status === 'unsupported' ? replay.reason : JSON.stringify(replay).slice(0, 200)
  }

  it('says so for a bitmap that outgrew work_mem and went lossy', async () => {
    // One row per page, more pages than a 64 kB bitmap can list row by row (about 1,170 in PGlite).
    await db.exec(`
      CREATE TABLE sparse (id int, pad text) WITH (fillfactor = 10, autovacuum_enabled = off);
      INSERT INTO sparse SELECT n, repeat('x', 1000) FROM generate_series(1, 1500) AS n;
      CREATE INDEX ON sparse (id);
    `)
    await db.exec(`VACUUM ANALYZE sparse`)
    await db.exec(`SET work_mem = '64kB'`)
    try {
      await without(['enable_seqscan', 'enable_indexscan'], async () => {
        const result = await run('SELECT * FROM sparse WHERE id > 0')
        expect(result.plan?.root.lossyHeapBlocks).toBeGreaterThan(0)
        expect(result.replay).toEqual({ status: 'unsupported', reason: LOSSY_REASON })
      })
    } finally {
      await db.exec('RESET work_mem; DROP TABLE sparse')
    }
  })

  it('says which node isn’t supported when bitmaps are combined', async () => {
    expect(await reason('SELECT * FROM orders WHERE customer_id = 42 OR id = 5')).toBe(
      'Animation isn’t available yet for BitmapOr.',
    )
  })
})
