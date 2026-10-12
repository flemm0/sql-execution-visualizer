import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt, type RowsResult, type RunOptions } from '../db/runner'
import { seedDatabase } from '../db/seed'
import type { Replay } from './replay'
import type { Trace, TraceEvent } from './trace'

/*
 * Index Only Scan replays. A database of its own: example 9 updates and
 * vacuums orders, which would move rows the other replay tests count on.
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

/** The replay of a query that must replay as an Index Only Scan, failing the test with its validation otherwise. */
async function replayed(sql: string, options?: RunOptions) {
  const result = await run(sql, options)
  const replay = result.replay as Replay
  expect(replay.status, JSON.stringify(replay).slice(0, 500)).toBe('replayed')
  if (replay.status !== 'replayed') throw new Error('not replayed')
  expect(result.plan?.root.nodeType).toBe('Index Only Scan')
  const failed = replay.validation.checks.filter((check) => !check.ok)
  expect(failed, `${sql}: ${JSON.stringify(replay.validation.notes)}`).toEqual([])
  return { result, trace: replay.trace, validation: replay.validation }
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

/** Runs `body` with some of the planner's choices turned off, so it picks the plan a test is about. */
async function without<T>(settings: string[], body: () => Promise<T>): Promise<T> {
  await db.exec(settings.map((setting) => `SET ${setting} = off;`).join(' '))
  try {
    return await body()
  } finally {
    await db.exec(settings.map((setting) => `RESET ${setting};`).join(' '))
  }
}

describe('replaying an Index Only Scan', () => {
  const example9 = 'SELECT order_date FROM orders WHERE customer_id = 42'

  it('example 9 after seeding: every page is all-visible, so the scan reads the visibility map and no heap page', async () => {
    const { result, trace, validation } = await replayed(example9)
    const orders = trace.relations.find((relation) => relation.name === 'orders')
    expect(result.plan?.root.title).toBe('Index Only Scan using orders_customer_id_order_date_idx on orders')
    expect(trace.events.map((event) => event.type)).toEqual([
      'node.start',
      'index.search',
      'buffer.read', // the root
      'index.visit',
      'buffer.read', // the leaf
      'index.visit',
      'index.entry',
      'buffer.read', // the visibility map's only page, once
      'visibility.check',
      'row.emit',
      'index.entry',
      'visibility.check',
      'row.emit',
      'index.entry',
      'visibility.check',
      'row.emit',
      'node.finish',
    ])
    expect(ofType(trace, 'buffer.read')[2].page).toEqual({ relation: orders?.id, block: 0, fork: 'vm' })
    const rows = await ctidsOf(`SELECT ctid::text FROM orders WHERE customer_id = 42 ORDER BY order_date, ctid`)
    expect(ofType(trace, 'visibility.check').map((event) => [text(event.row), event.allVisible, event.matched])).toEqual(
      rows.map((row) => [row, true, true]),
    )
    expect(ofType(trace, 'row.emit').map((event) => text(event.row))).toEqual(rows)
    expect(ofType(trace, 'heap.tuple')).toEqual([])

    expect(validation.checks.map((check) => check.label)).toEqual([
      'Index Only Scan using orders_customer_id_order_date_idx on orders: rows',
      'Index Only Scan using orders_customer_id_order_date_idx on orders: index searches',
      'Index Only Scan using orders_customer_id_order_date_idx on orders: heap fetches',
      'Index Only Scan using orders_customer_id_order_date_idx on orders: buffer hits',
      'Index Only Scan using orders_customer_id_order_date_idx on orders: buffer reads',
      'Result: rows',
      'Result: rows with the same values, in the same order',
    ])
  })

  it('example 9: an update clears the pages’ bits, so rows are fetched (0 → 6 → 3 heap fetches), until VACUUM sets them again (0)', async () => {
    const before = await ctidsOf(`SELECT ctid::text FROM orders WHERE customer_id = 42`)
    await db.exec(`UPDATE orders SET total = total WHERE customer_id = 42`)

    // The old versions' entries are still in the index, and the new versions
    // got entries of their own (they moved to another page, so the update
    // couldn't be HOT). Every page involved has lost its all-visible bit.
    const first = await replayed(example9)
    const fetched = ofType(first.trace, 'heap.tuple')
    expect(first.result.plan?.root.heapFetches).toBe(6)
    expect(fetched).toHaveLength(6)
    expect(ofType(first.trace, 'visibility.check').every((event) => !event.allVisible && event.matched === null)).toBe(true)
    expect(fetched.filter((event) => event.visible === null).map((event) => text(event.row)).sort()).toEqual(before.sort())
    // It marks the old versions' entries dead without another buffer access: an index-only scan keeps its leaf pinned.
    const [marked] = ofType(first.trace, 'index.markDead')
    expect(marked.offsets).toHaveLength(3)
    const types = first.trace.events.map((event) => event.type)
    expect(types.slice(types.indexOf('index.markDead') - 1, types.indexOf('index.markDead') + 2)).toEqual([
      'row.emit',
      'index.markDead',
      'node.finish',
    ])

    const second = await replayed(example9)
    expect(ofType(second.trace, 'heap.tuple')).toHaveLength(3)
    expect(ofType(second.trace, 'index.markDead')).toEqual([])

    await db.exec('VACUUM orders')
    const vacuumed = await replayed(example9)
    expect(ofType(vacuumed.trace, 'heap.tuple')).toEqual([])
    expect(ofType(vacuumed.trace, 'visibility.check').map((event) => event.allVisible)).toEqual([true, true, true])
  })

  it('with a warm cache, every page is a hit, the visibility map’s too', async () => {
    await run(example9, {})
    const { trace } = await replayed(example9, {})
    expect(ofType(trace, 'buffer.read')).toEqual([])
    expect(ofType(trace, 'buffer.hit').map((event) => event.page.fork)).toEqual([undefined, undefined, 'vm'])
  })

  it('checks the filter on an all-visible page’s entries, and counts the ones that fail as removed', async () => {
    const sql = `SELECT customer_id, order_date FROM orders WHERE customer_id BETWEEN 40 AND 60 AND extract(dow FROM order_date) = 1`
    const { result, trace, validation } = await replayed(sql)
    expect(result.plan?.root.filter).not.toBeNull()
    const rejected = ofType(trace, 'visibility.check').filter((event) => event.matched === false)
    expect(rejected.length).toBeGreaterThan(0)
    const fetchedAndRejected = ofType(trace, 'heap.tuple').filter((event) => event.visible !== null && !event.matched)
    expect(validation.checks.find((check) => check.label.endsWith('rows removed by filter'))?.replay).toBe(
      rejected.length + fetchedAndRejected.length,
    )
  })

  it('a table never vacuumed has no visibility map: no map page is read, and every row is fetched', async () => {
    await db.exec(`
      CREATE TABLE fresh (id int PRIMARY KEY, note text) WITH (autovacuum_enabled = off);
      INSERT INTO fresh SELECT n, 'note ' || n FROM generate_series(1, 2000) AS n;
      ANALYZE fresh;
    `)
    const { trace } = await without(['enable_seqscan', 'enable_bitmapscan'], () =>
      replayed('SELECT id FROM fresh WHERE id BETWEEN 100 AND 120'),
    )
    expect(trace.events.some((event) => 'page' in event && event.page.fork === 'vm')).toBe(false)
    expect(ofType(trace, 'heap.tuple')).toHaveLength(21)
    await db.exec('DROP TABLE fresh')
  })

  it('on an all-visible page, a row updated in place (HOT) is the version its entry’s line pointer redirects to', async () => {
    await db.exec(`
      CREATE TABLE stock (id int PRIMARY KEY, count int) WITH (fillfactor = 50, autovacuum_enabled = off);
      INSERT INTO stock SELECT n, 0 FROM generate_series(1, 500) AS n;
      UPDATE stock SET count = 1 WHERE id BETWEEN 10 AND 12;
    `)
    await db.exec('VACUUM stock')
    const { trace } = await without(['enable_seqscan', 'enable_bitmapscan'], () =>
      replayed('SELECT id FROM stock WHERE id BETWEEN 8 AND 14'),
    )
    expect(ofType(trace, 'heap.tuple')).toEqual([])
    const emitted = ofType(trace, 'row.emit').map((event) => text(event.row))
    expect(emitted).toEqual(await ctidsOf('SELECT ctid::text FROM stock WHERE id BETWEEN 8 AND 14 ORDER BY id'))
    // The entries still point at the line pointers the rows started at.
    const pointed = ofType(trace, 'index.entry').map((event) => text(event.row))
    expect(pointed.filter((tid, i) => tid !== emitted[i])).toHaveLength(3)
    await db.exec('DROP TABLE stock')
  })
})
