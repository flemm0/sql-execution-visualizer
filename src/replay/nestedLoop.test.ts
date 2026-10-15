import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { findRelations } from '../db/inspector'
import { parsePlan, tablesInPlan, type PlanNode } from '../db/plan'
import { runStatementAt, type RowsResult, type RunOptions } from '../db/runner'
import { seedDatabase } from '../db/seed'
import { prepareReplay, type Replay } from './replay'
import type { Trace, TraceEvent } from './trace'
import { validate } from './validate'

/*
 * Nested Loop replays: the inner side runs once per outer row, with that
 * row's values as its parameters, and the validator checks every node over
 * all its loops. A database of its own: the last test updates orders.
 */

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
}, 120_000)
afterAll(() => db.close())

const EXAMPLE_13 = `SELECT c.first_name, c.last_name, o.id, o.order_date FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.last_name = 'Hawkins'`
const SELF_JOIN = 'SELECT a.name, b.name FROM categories a CROSS JOIN categories b WHERE a.id < b.id'

async function run(sql: string, options: RunOptions = { emptyCache: true }): Promise<RowsResult> {
  const [result] = await runStatementAt(db, sql, 0, options)
  if (result.status !== 'rows') throw new Error(`${sql}: ${JSON.stringify(result).slice(0, 300)}`)
  return result
}

/** The replay of a query that must replay, failing the test with its validation otherwise. */
async function replayed(sql: string) {
  const result = await run(sql)
  const replay = result.replay as Replay
  expect(replay.status, JSON.stringify(replay).slice(0, 500)).toBe('replayed')
  if (replay.status !== 'replayed' || result.plan === null) throw new Error('not replayed')
  const failed = replay.validation.checks.filter((check) => !check.ok)
  expect(failed, `${sql}: ${JSON.stringify(replay.validation.notes)}`).toEqual([])
  return { result, plan: result.plan, trace: replay.trace, validation: replay.validation }
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

function ofType<T extends TraceEvent['type']>(trace: Trace, type: T) {
  return trace.events.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type)
}

function text(row: { block: number; offset: number }) {
  return `(${row.block},${row.offset})`
}

/** The plan's nodes as "id: title", depth first. */
function nodes(node: PlanNode): string[] {
  return [`${node.id}: ${node.title}`, ...node.children.flatMap(nodes)]
}

/** The heap and index pages a node asked for, in order: [block, 'hit' or 'read']. */
function accesses(trace: Trace, node: number) {
  return trace.events.flatMap((event) =>
    (event.type === 'buffer.hit' || event.type === 'buffer.read') && event.node === node
      ? [[event.page.block, event.type === 'buffer.hit' ? 'hit' : 'read'] as const]
      : [],
  )
}

describe('replaying a Nested Loop', () => {
  it('example 13: for each of 38 customers, the inner Index Scan searches orders again, for that customer’s id', async () => {
    const { plan, trace, validation } = await replayed(EXAMPLE_13)
    expect(nodes(plan.root)).toEqual([
      '0: Nested Loop',
      '1: Bitmap Heap Scan on customers c',
      '2: Bitmap Index Scan on customers_last_name_first_name_idx',
      '3: Index Scan using orders_customer_id_order_date_idx on orders o',
    ])

    // The outer side's rows in bitmap order (physical), each followed by a loop of the inner side, for its id.
    const customers = await db.query<{ ctid: string; id: string }>(
      `SELECT ctid::text, id::text FROM customers WHERE last_name = 'Hawkins' ORDER BY customers.ctid`,
    )
    const loops = ofType(trace, 'join.loop')
    expect(loops.map((loop) => loop.loop)).toEqual([...Array(38).keys()].map((i) => i + 1))
    expect(loops.map((loop) => loop.outer.map(text))).toEqual(customers.rows.map((row) => [row.ctid]))
    expect(loops.map((loop) => loop.params)).toEqual(customers.rows.map((row) => [{ name: 'c.id', value: row.id }]))
    for (const loop of loops) {
      const at = trace.events.indexOf(loop)
      // Right after the outer row goes up to the join; the inner scan starts again, and searches its index once.
      expect(trace.events[at - 1]).toMatchObject({ type: 'row.emit', node: 1, row: { block: loop.outer[0].block, offset: loop.outer[0].offset } })
      expect(trace.events.slice(at + 1, at + 3)).toEqual([
        { type: 'node.start', node: 3 },
        { type: 'index.search', node: 3, index: expect.any(Number) },
      ])
    }
    expect(ofType(trace, 'node.start').filter((event) => event.node === 3)).toHaveLength(38)
    expect(ofType(trace, 'node.finish').filter((event) => event.node === 3)).toHaveLength(38)

    // Each joined row: the customer's row and one of their orders, in the order Postgres returns them.
    const joined = await db.query<{ c: string; o: string }>(
      `SELECT c.ctid::text AS c, o.ctid::text AS o FROM customers c JOIN orders o ON o.customer_id = c.id
       WHERE c.last_name = 'Hawkins' ORDER BY c.ctid, o.order_date, o.ctid`,
    )
    const emitted = ofType(trace, 'row.emit').filter((event) => event.node === 0)
    expect(emitted.map((event) => [...(event.outer ?? []).map(text), text(event.row)])).toEqual(joined.rows.map((row) => [row.c, row.o]))
    expect(emitted.map((event) => event.resultIndex)).toEqual([...Array(197).keys()])
    expect(trace.events.at(-1)).toEqual({ type: 'node.finish', node: 0 })

    // Checked over every loop: the inner scan's rows per loop, and its searches and buffers in all.
    const inner = validation.checks.filter((check) => check.label.startsWith('Index Scan using orders_customer_id_order_date_idx'))
    expect(inner.map(({ label, postgres, loops: count }) => ({ label: label.split(': ')[1], postgres, loops: count }))).toEqual([
      { label: 'rows', postgres: 5.18, loops: 38 },
      { label: 'index searches', postgres: 38, loops: undefined },
      { label: 'buffer hits', postgres: 72, loops: undefined },
      { label: 'buffer reads', postgres: 201, loops: undefined },
    ])
    // Heap pages of both tables are in the trace's internals.
    expect(new Set(trace.heapPages.map((page) => page.relation)).size).toBe(2)
  })

  it('walks each loop’s search of the index before the query runs, for its customer', async () => {
    const json = (await db.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (VERBOSE, FORMAT JSON) ${EXAMPLE_13}`)).rows[0]['QUERY PLAN']
    const prepared = await prepareReplay(db, parsePlan(json), await findRelations(db, tablesInPlan(json)))
    expect(prepared?.status).toBe('walked')
    if (prepared?.status !== 'walked') return
    // The outer bitmap scan's walk, and one walk of orders' index per customer, with their id in its condition.
    const walks = [...prepared.walks.values()].map((walked) => walked.walk)
    expect(walks.map((walk) => walk.indexName)).toEqual(['customers_last_name_first_name_idx', ...Array(38).fill('orders_customer_id_order_date_idx')])
    const ids = await db.query<{ id: number }>(`SELECT id FROM customers WHERE last_name = 'Hawkins' ORDER BY ctid`)
    expect(walks.slice(1).map((walk) => walk.indexCond)).toEqual(ids.rows.map((row) => `(o.customer_id = ('${row.id}'::integer))`))
  })

  it('replays an inner Bitmap Heap Scan with parameters, its heap blocks counted over every loop', async () => {
    const { plan, trace } = await without(['enable_indexscan'], () => replayed(EXAMPLE_13))
    expect(nodes(plan.root).slice(3)).toEqual(['3: Bitmap Heap Scan on orders o', '4: Bitmap Index Scan on orders_customer_id_order_date_idx'])
    expect(plan.root.children[1].exactHeapBlocks).toBe(196)
    expect(ofType(trace, 'join.loop')).toHaveLength(38)
    expect(ofType(trace, 'index.search').filter((event) => event.node === 4)).toHaveLength(38)
  })

  it('puts a parameter into the inner scan’s Filter too', async () => {
    const sql = `SELECT c.id, o.id FROM customers c JOIN orders o ON o.customer_id = c.id AND o.total > c.id WHERE c.last_name = 'Hawkins'`
    const { plan, validation } = await replayed(sql)
    const inner = plan.root.children[1]
    expect(inner.filter).toBe('(o.total > (c.id)::numeric)')
    expect(validation.checks.find((check) => check.label === `${inner.title}: rows removed by filter`)).toMatchObject({ postgres: 5, loops: 38, ok: true })
  })

  it('replays an inner range scan whose bound is the outer row’s value', async () => {
    const { plan, trace } = await without(['enable_material'], () => replayed(SELF_JOIN))
    expect(plan.root.children[1].indexCond).toBe('(b.id > a.id)')
    expect(ofType(trace, 'join.loop').map((loop) => loop.params[0].value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
  })

  it('checks a Join Filter on every pair, and plays two scans of one table in the order they ask for its page', async () => {
    const { plan, trace } = await without(['enable_material', 'enable_indexscan', 'enable_bitmapscan'], () => replayed(SELF_JOIN))
    expect(nodes(plan.root)).toEqual(['0: Nested Loop', '1: Seq Scan on categories a', '2: Seq Scan on categories b'])
    expect(plan.root.joinFilter).toBe('(a.id < b.id)')

    // Each of the 12 × 12 pairs, checked by Postgres; the 66 that pass go up, the 78 others are dropped.
    const pairs = await db.query<{ a: string; b: string; passes: boolean }>(
      `SELECT a.ctid::text AS a, b.ctid::text AS b, a.id < b.id AS passes FROM categories a CROSS JOIN categories b ORDER BY a.ctid, b.ctid`,
    )
    const checked = ofType(trace, 'join.filter')
    expect(checked.map((event) => [text(event.outer[0]), text(event.row), event.matched])).toEqual(pairs.rows.map((row) => [row.a, row.b, row.passes]))
    // Each pair that passes goes up right after its check.
    for (const event of checked.filter((check) => check.matched)) {
      expect(trace.events[trace.events.indexOf(event) + 1]).toMatchObject({ type: 'row.emit', node: 0, row: event.row, outer: event.outer })
    }

    // On an empty cache, the outer scan asks for the table's one page first and reads it; each loop of the inner scan then finds it.
    expect(accesses(trace, 1)).toEqual([[0, 'read']])
    expect(accesses(trace, 2)).toEqual(Array(12).fill([0, 'hit']))
    // Without parameters, every loop does the same work.
    expect(ofType(trace, 'join.loop').every((loop) => loop.params.length === 0)).toBe(true)
  })

  it('asks an Inner Unique join’s inner side for one row per loop', async () => {
    const sql = 'SELECT o.id, o.order_date, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id BETWEEN 1000 AND 1009'
    const { plan, trace } = await replayed(sql)
    expect(plan.root.innerUnique).toBe(true)
    // customers_pkey: one search, a leaf, one row; the scan doesn't look further, so it never finishes a loop.
    expect(ofType(trace, 'index.entry').filter((event) => event.node === 2)).toHaveLength(10)
    expect(ofType(trace, 'node.finish').filter((event) => event.node === 2)).toHaveLength(0)
    expect(trace.events.at(-1)).toEqual({ type: 'node.finish', node: 0 })
  })

  it('replays a join of four tables: each Nested Loop’s outer row is a row of every table before it', async () => {
    const sql = `SELECT c.email, o.id, o.order_date, p.name, oi.quantity FROM customers c JOIN orders o ON o.customer_id = c.id
      JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id WHERE c.email = 'angela.hawkins42@example.com'`
    const { plan, trace } = await replayed(sql)
    expect(plan.root.nodeType).toBe('Nested Loop')
    // The innermost loop, on products, is driven by rows of customers, orders and order_items.
    const products = ofType(trace, 'join.loop').filter((loop) => loop.node === plan.root.id)
    expect(products).toHaveLength(10)
    expect(products.every((loop) => loop.outer.length === 3)).toBe(true)
    expect(products[0].params.map((param) => param.name)).toEqual(['oi.product_id'])
    expect(ofType(trace, 'row.emit').filter((event) => event.resultIndex !== null).every((event) => event.outer?.length === 3)).toBe(true)
  })

  it('says a join under a LIMIT, or another kind of join, isn’t available yet', async () => {
    const limited = await run(`${EXAMPLE_13} LIMIT 5`)
    expect(limited.replay).toEqual({ status: 'unsupported', reason: 'Animation isn’t available yet for a Limit above a join.' })
    const sorted = await run(`${EXAMPLE_13} ORDER BY o.order_date`)
    expect(sorted.plan?.root.nodeType).toBe('Sort')
    expect(sorted.replay).toEqual({ status: 'unsupported', reason: 'Animation isn’t available yet for a Sort above a join.' })
    const left = await run(`SELECT c.id, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.last_name = 'Hawkins'`)
    expect(left.plan?.root.title).toBe('Nested Loop Left Join')
    expect(left.replay).toEqual({ status: 'unsupported', reason: 'Animation isn’t available yet for Nested Loop Left Join.' })
  })

  it('fails the inner scan’s check per loop when the replay is a row short', async () => {
    const { result, plan, trace } = await replayed(EXAMPLE_13)
    // Drop the inner scan's last row and the joined row it made.
    const lastInner = trace.events.findLastIndex((event) => event.type === 'row.emit' && event.node === 3)
    const events = trace.events.filter((_, i) => i !== lastInner && i !== lastInner + 1)
    const validation = validate({
      plan,
      trace: { ...trace, events },
      resultRows: result.rows,
      totalRows: result.totalRows,
      replayedRows: result.rows.map((row) => [...row]),
      notes: [],
    })
    const failed = validation.checks.filter((check) => !check.ok)
    // 196 rows over 38 loops is 5.16 a loop; Postgres says 5.18.
    expect(failed).toContainEqual({
      label: 'Index Scan using orders_customer_id_order_date_idx on orders o: rows',
      postgres: 5.18,
      replay: 5.16,
      ok: false,
      loops: 38,
    })
  })

  it('counts an inner Index Only Scan’s heap fetches over every loop, after an UPDATE gives the orders new versions', async () => {
    const sql = `SELECT c.id, o.order_date FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.last_name = 'Hawkins'`
    await db.exec(`UPDATE orders SET status = status WHERE customer_id IN (SELECT id FROM customers WHERE last_name = 'Hawkins')`)
    // The first run finds the old versions' entries and marks them dead; the second skips them.
    const first = await replayed(sql)
    const inner = first.plan.root.children[1]
    expect(inner.nodeType).toBe('Index Only Scan')
    expect(inner.heapFetches).toBeGreaterThan(197)
    expect(ofType(first.trace, 'index.markDead').length).toBeGreaterThan(0)
    const again = await replayed(sql)
    expect(again.plan.root.children[1].heapFetches).toBe(197)
  })
})
