import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt, type RowsResult, type RunOptions } from '../db/runner'
import { seedDatabase } from '../db/seed'
import type { Replay } from './replay'
import type { Trace, TraceEvent } from './trace'

/*
 * Sort and Limit replays: example 10, top-N heapsorts, ties, OFFSET, and
 * scans a Limit stops early. A database of its own: some tests delete rows
 * or add tables.
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

function ofType<T extends TraceEvent['type']>(trace: Trace, type: T) {
  return trace.events.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type)
}

/** The node ids of a type of event, in order. */
function nodesOf(trace: Trace, type: TraceEvent['type']) {
  return trace.events.filter((event) => event.type === type).map((event) => event.node)
}

/** The plan's node types, outermost first. */
function nodeTypes(result: RowsResult) {
  const types: string[] = []
  for (let node = result.plan?.root; node !== undefined; node = node.children[0]) types.push(node.nodeType)
  return types
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

describe('example 10: top-N', () => {
  it('with the index in the right order, a Limit over a backward index scan: 3 rows, then it stops', async () => {
    const { result, trace } = await replayed('SELECT * FROM orders WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3')
    expect(nodeTypes(result)).toEqual(['Limit', 'Index Scan'])
    expect(result.plan?.root.children[0].title).toBe('Index Scan Backward using orders_customer_id_order_date_idx on orders')
    // Each row goes up from the scan, then from the Limit to the result.
    expect(ofType(trace, 'row.emit').map((event) => [event.node, event.resultIndex])).toEqual([
      [1, null],
      [0, 0],
      [1, null],
      [0, 1],
      [1, null],
      [0, 2],
    ])
    // With its 3 rows, the Limit stops; the scan never finishes.
    expect(trace.events.slice(-2)).toEqual([
      { type: 'limit.stop', node: 0, stopped: [1] },
      { type: 'node.finish', node: 0 },
    ])
    expect(nodesOf(trace, 'node.finish')).toEqual([0])
  })

  it('ordered by a column the index doesn’t have: a Sort of every matching row, then the Limit takes the first', async () => {
    const { result, trace } = await replayed('SELECT * FROM orders WHERE customer_id = 42 ORDER BY total DESC LIMIT 10')
    expect(nodeTypes(result)).toEqual(['Limit', 'Sort', 'Bitmap Heap Scan', 'Bitmap Index Scan'])
    // The Sort reads all 3 rows before it passes one on, sorts them in memory, then passes them on in order.
    const done = trace.events.findIndex((event) => event.type === 'sort.done')
    expect(trace.events[done]).toEqual({ type: 'sort.done', node: 1, rows: 3, method: 'quicksort' })
    expect(trace.events.slice(0, done).filter((event) => event.type === 'row.emit').map((event) => event.node)).toEqual([2, 2, 2])
    expect(trace.events.slice(done).filter((event) => event.type === 'row.emit').map((event) => event.node)).toEqual([1, 0, 1, 0, 1, 0])
    // It has fewer rows than the Limit's 10: the Limit asks once more, and both finish; nothing is stopped.
    expect(ofType(trace, 'limit.stop')).toEqual([])
    expect(trace.events.slice(-2)).toEqual([
      { type: 'node.finish', node: 1 },
      { type: 'node.finish', node: 0 },
    ])
    // The sort keys, as Postgres writes them.
    expect(trace.sorts).toHaveLength(1)
    expect(trace.sorts[0].keys).toEqual(['orders.total DESC'])
    const totals = result.rows.map((row) => row[4])
    expect(trace.sorts[0].rows.map((row) => row.key[0]).sort()).toEqual([...totals].sort())
  })
})

describe('replaying a Sort', () => {
  it('a top-N heapsort keeps the best 10 of 50,000 rows, deciding each row as it comes', async () => {
    const { result, trace } = await replayed('SELECT * FROM orders ORDER BY total DESC LIMIT 10')
    expect(nodeTypes(result)).toEqual(['Limit', 'Sort', 'Seq Scan'])
    expect(result.plan?.root.children[0].sortMethod).toBe('top-N heapsort')
    // Up to twice the bound it keeps every row; at the 21st it switches, keeping 10 and dropping 11.
    const [heap] = ofType(trace, 'sort.heap')
    expect(heap.kept).toHaveLength(10)
    expect(heap.dropped).toHaveLength(11)
    expect(ofType(trace, 'sort.keep').length + ofType(trace, 'sort.discard').length).toBe(50_000 - 21)
    expect(ofType(trace, 'sort.done')).toEqual([{ type: 'sort.done', node: 1, rows: 10, method: 'top-N heapsort' }])
    // The Limit takes its 10 and stops the Sort.
    expect(ofType(trace, 'limit.stop')).toEqual([{ type: 'limit.stop', node: 0, stopped: [1] }])
  })

  it('rows that tie come out in Postgres’s order, in a quicksort and in a top-N heapsort', async () => {
    // 300 rows, in no order, with 5 sort key values between them.
    await db.exec(`CREATE TABLE ties AS SELECT g AS id, (g * 7919) % 5 AS k FROM generate_series(1, 300) AS g; ANALYZE ties`)
    try {
      const quick = await replayed('SELECT * FROM ties ORDER BY k')
      expect(ofType(quick.trace, 'sort.done')[0].method).toBe('quicksort')
      // The validator compared the rows' values in order: ids within each tie included.
      const ids = new Set(quick.result.rows.slice(0, 60).map((row) => row[1]))
      expect(ids.size).toBe(1)
      for (const sql of ['SELECT * FROM ties ORDER BY k LIMIT 7', 'SELECT * FROM ties ORDER BY k DESC, id % 3 LIMIT 40']) {
        const topN = await replayed(sql)
        expect(ofType(topN.trace, 'sort.done')[0].method).toBe('top-N heapsort')
      }
    } finally {
      await db.exec('DROP TABLE ties')
    }
  })

  it('a Sort with no Limit sorts and passes on every row', async () => {
    const { result, trace } = await replayed('SELECT * FROM categories ORDER BY name')
    expect(nodeTypes(result)).toEqual(['Sort', 'Seq Scan'])
    expect(ofType(trace, 'row.emit').filter((event) => event.resultIndex !== null)).toHaveLength(12)
    expect(trace.events.at(-1)).toEqual({ type: 'node.finish', node: 0 })
  })
})

describe('replaying a Limit', () => {
  it('OFFSET: the first rows are skipped, then the Limit passes the next ones on', async () => {
    const { result, trace } = await replayed('SELECT * FROM orders ORDER BY id OFFSET 5 LIMIT 3')
    expect(result.rows.map((row) => row[0])).toEqual(['6', '7', '8'])
    expect(ofType(trace, 'limit.skip').map((event) => event.row)).toHaveLength(5)
    expect(ofType(trace, 'row.emit').filter((event) => event.node === 0)).toHaveLength(3)
  })

  it('LIMIT 0 asks for nothing: the scan below never starts', async () => {
    const { trace } = await replayed('SELECT * FROM orders LIMIT 0')
    expect(trace.events).toEqual([
      { type: 'node.start', node: 0 },
      { type: 'limit.stop', node: 0, stopped: [] },
      { type: 'node.finish', node: 0 },
    ])
  })

  it('stops a Seq Scan part way through a page, its filter checked only up to there', async () => {
    const { result, trace } = await replayed(`SELECT * FROM orders WHERE status = 'pending' LIMIT 5`)
    expect(nodeTypes(result)).toEqual(['Limit', 'Seq Scan'])
    const last = ofType(trace, 'heap.page').at(-1)
    expect(last?.checkedRows).toBeLessThan(last?.visibleRows as number)
    expect(last?.matchedRows).toBeGreaterThan(0)
  })

  it('a stopped Seq Scan has read pages ahead it won’t use, in Postgres 18’s batches', async () => {
    // 500 rows end on page 3, in the batch of pages 3 to 6: pages 4 to 6 were read for nothing.
    const cold = await replayed('SELECT * FROM order_items LIMIT 500')
    const ahead = cold.trace.events.filter((event) => (event.type === 'buffer.read' || event.type === 'buffer.hit') && event.ahead)
    expect(ahead.map((event) => [event.type, 'page' in event ? event.page.block : null])).toEqual([
      ['buffer.read', 4],
      ['buffer.read', 5],
      ['buffer.read', 6],
    ])
    // They come after the Limit stops.
    const stop = cold.trace.events.findIndex((event) => event.type === 'limit.stop')
    expect(cold.trace.events.slice(stop + 1, stop + 4)).toEqual(ahead)
    // With every page cached, the stream pins one page ahead: one hit for nothing.
    await run('SELECT count(*) FROM order_items')
    const warm = await replayed('SELECT * FROM order_items LIMIT 500', { emptyCache: false })
    const warmAhead = warm.trace.events.filter((event) => (event.type === 'buffer.read' || event.type === 'buffer.hit') && event.ahead)
    expect(warmAhead.map((event) => event.type)).toEqual(['buffer.hit'])
  })

  it('stops a Bitmap Heap Scan early; Exact Heap Blocks counts only the pages it reached', async () => {
    await without(['enable_seqscan', 'enable_indexscan'], async () => {
      for (const limit of [1, 2, 5, 20, 100]) {
        const { result } = await replayed(`SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300 LIMIT ${limit}`)
        expect(nodeTypes(result)).toEqual(['Limit', 'Bitmap Heap Scan', 'Bitmap Index Scan'])
      }
    })
  })

  it('a stopped index scan marks the dead entries it found as the query ends, in no node’s buffers', async () => {
    await db.exec('DELETE FROM order_items WHERE order_id = 1501; DELETE FROM orders WHERE id = 1501')
    const sql = 'SELECT * FROM orders WHERE id BETWEEN 1500 AND 1600 ORDER BY id LIMIT 3'
    const first = await replayed(sql)
    expect(nodeTypes(first.result)).toEqual(['Limit', 'Index Scan'])
    const stop = first.trace.events.findIndex((event) => event.type === 'limit.stop')
    expect(first.trace.events.slice(stop)).toEqual([
      { type: 'limit.stop', node: 0, stopped: [1] },
      { type: 'index.markDead', node: 1, page: expect.any(Object), offsets: [expect.any(Number)] },
      { type: 'node.finish', node: 0 },
    ])
    // The next run skips the entry.
    const second = await replayed(sql)
    expect(ofType(second.trace, 'heap.tuple')).toHaveLength(3)
  })
})

describe('Limits and Sorts in a subquery', () => {
  it('a Limit over a Limit, and a Sort over a Limit, each with its own LIMIT', async () => {
    const nested = await replayed('SELECT * FROM (SELECT * FROM orders ORDER BY id LIMIT 20) s LIMIT 5')
    expect(nodeTypes(nested.result)).toEqual(['Limit', 'Limit', 'Index Scan'])
    expect(nested.trace.limits).toEqual([
      { node: 0, offset: 0, count: 5 },
      { node: 1, offset: 0, count: 20 },
    ])
    // The outer Limit stops both: the inner one with 5 of its 20, and the scan.
    expect(ofType(nested.trace, 'limit.stop')).toEqual([{ type: 'limit.stop', node: 0, stopped: [1, 2] }])
    const sorted = await replayed('SELECT * FROM (SELECT * FROM orders LIMIT 10) s ORDER BY total')
    expect(nodeTypes(sorted.result)).toEqual(['Sort', 'Limit', 'Seq Scan'])
  })
})

describe('a Sort or Limit the replay engine can’t replay yet', () => {
  async function reason(sql: string) {
    const replay = (await run(sql)).replay
    return replay?.status === 'unsupported' ? replay.reason : JSON.stringify(replay).slice(0, 200)
  }

  it('says so for a sort that spills to disk, FETCH FIRST WITH TIES, and a LIMIT only known when the query runs', async () => {
    expect(await reason('SELECT * FROM orders ORDER BY total')).toBe(
      'Animation isn’t available yet for sorts that spill to disk (external merge): this one outgrew work_mem.',
    )
    expect(await reason('SELECT * FROM orders WHERE customer_id = 42 ORDER BY total FETCH FIRST 2 ROWS WITH TIES')).toBe(
      'Animation isn’t available yet for FETCH FIRST … WITH TIES.',
    )
    expect(await reason('SELECT * FROM orders LIMIT (SELECT 3)')).toMatch(/^Animation isn’t available yet for /)
  })
})
