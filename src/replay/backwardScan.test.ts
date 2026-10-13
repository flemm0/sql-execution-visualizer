import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt, type RowsResult, type RunOptions } from '../db/runner'
import { seedDatabase } from '../db/seed'
import type { Replay } from './replay'
import type { Trace, TraceEvent } from './trace'

/*
 * Backward index scans: ORDER BY ... DESC read from an ascending B-tree, from
 * high keys to low. A database of its own: the tests delete rows and add an
 * index.
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

/** The replay of a query that must replay with a backward scan at the top, failing the test with its validation otherwise. */
async function backward(sql: string, nodeType = 'Index Scan', options?: RunOptions) {
  const result = await run(sql, options)
  const replay = result.replay as Replay
  expect(replay.status, JSON.stringify(replay).slice(0, 500)).toBe('replayed')
  if (replay.status !== 'replayed') throw new Error('not replayed')
  expect(result.plan?.root.nodeType).toBe(nodeType)
  expect(result.plan?.root.backward).toBe(true)
  const failed = replay.validation.checks.filter((check) => !check.ok)
  expect(failed, `${sql}: ${JSON.stringify(replay.validation.notes)}`).toEqual([])
  return { result, trace: replay.trace, validation: replay.validation }
}

function ofType<T extends TraceEvent['type']>(trace: Trace, type: T) {
  return trace.events.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type)
}

/** The index pages an index scan read, in order, as [block, level]. */
function indexVisits(trace: Trace) {
  return ofType(trace, 'index.visit').map((event) => [event.page.block, event.level])
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

describe('replaying a backward index scan', () => {
  it('example 10’s scan: one customer’s orders from the latest date down, root then leaf, 3 rows', async () => {
    const sql = 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY order_date DESC'
    const { result, trace, validation } = await without(['enable_bitmapscan', 'enable_sort'], () => backward(sql))
    expect(result.plan?.root.title).toBe('Index Scan Backward using orders_customer_id_order_date_idx on orders')
    expect(indexVisits(trace).map(([, level]) => level)).toEqual([1, 0])
    // Entries come latest date first: the result's order.
    expect(result.rows.map((row) => row[2])).toEqual([...result.rows.map((row) => row[2] as string)].sort().reverse())
    expect(ofType(trace, 'row.emit')).toHaveLength(3)
    // The trace says the search runs backward, so the player can say it moves left.
    expect(ofType(trace, 'index.search')).toEqual([{ type: 'index.search', node: 0, index: expect.any(Number), backward: true }])
    expect(validation.checks.map((check) => check.label)).toContain(
      'Index Scan Backward using orders_customer_id_order_date_idx on orders: index searches',
    )
  })

  it('an index-only scan reads backward too', async () => {
    const sql = 'SELECT order_date FROM orders WHERE customer_id = 42 ORDER BY order_date DESC'
    const { result } = await backward(sql, 'Index Only Scan')
    expect(result.rows).toHaveLength(3)
  })

  it('a range moves left from leaf to leaf, the same leaves a forward scan reads, in the opposite order', async () => {
    const forward = await without(['enable_bitmapscan', 'enable_sort'], async () => {
      const result = await run('SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000 ORDER BY id')
      const replay = result.replay as Replay
      if (replay.status !== 'replayed') throw new Error(JSON.stringify(replay))
      return replay.trace
    })
    const { trace, result } = await without(['enable_bitmapscan', 'enable_sort'], () =>
      backward('SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000 ORDER BY id DESC'),
    )
    const leaves = (each: Trace) => indexVisits(each).filter(([, level]) => level === 0).map(([block]) => block)
    expect(leaves(trace)).toHaveLength(4)
    expect(leaves(trace)).toEqual([...leaves(forward)].reverse())
    expect(result.totalRows).toBe(1001)
    expect(result.rows[0][0]).toBe('2000')
  })

  it('searches for < and <= start at the right entry; a lower bound alone starts before any NULLs', async () => {
    await without(['enable_bitmapscan', 'enable_sort'], async () => {
      for (const sql of [
        'SELECT * FROM orders WHERE id < 3000 ORDER BY id DESC LIMIT 5',
        'SELECT * FROM orders WHERE id <= 3000 ORDER BY id DESC LIMIT 5',
      ]) {
        const result = await run(sql.replace(' LIMIT 5', ''))
        expect(result.plan?.root.nodeType).toBe('Index Scan')
        const replay = result.replay as Replay
        if (replay.status !== 'replayed') throw new Error(JSON.stringify(replay))
        expect(replay.validation.checks.filter((check) => !check.ok)).toEqual([])
      }
      const { result } = await backward('SELECT * FROM orders WHERE id > 49000 ORDER BY id DESC')
      expect(result.rows[0][0]).toBe('50000')
    })
  })

  it('a multi-column range, and no condition at all: down the right edge of the tree', async () => {
    await without(['enable_bitmapscan', 'enable_sort', 'enable_seqscan'], async () => {
      await backward('SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 110 ORDER BY customer_id DESC, order_date DESC')
      const { trace } = await backward('SELECT id FROM orders ORDER BY id DESC', 'Index Only Scan')
      // Every leaf of orders_pkey, right to left.
      const leaves = indexVisits(trace).filter(([, level]) => level === 0)
      expect(leaves.length).toBeGreaterThan(100)
    })
  })

  it('posting lists give their rows in ascending order, each list from the right end of the page leftward', async () => {
    await db.exec('CREATE INDEX orders_status_idx ON orders (status)')
    try {
      await without(['enable_bitmapscan', 'enable_sort', 'enable_seqscan'], async () => {
        const { result, trace } = await backward(`SELECT * FROM orders WHERE status > 'pending' ORDER BY status DESC`)
        const shipped = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM orders WHERE status = 'shipped'`)
        expect(result.totalRows).toBe(shipped.rows[0].count)
        // The leaves hold posting lists: one entry for many rows.
        expect(trace.indexPages.some((page) => page.items.some((item) => item.rows > 1))).toBe(true)
      })
    } finally {
      await db.exec('DROP INDEX orders_status_idx')
    }
  })

  it('marks entries of deleted rows dead, and the next backward scan skips them', async () => {
    await db.exec('DELETE FROM order_items WHERE order_id BETWEEN 1500 AND 1510; DELETE FROM orders WHERE id BETWEEN 1500 AND 1510')
    const sql = 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000 ORDER BY id DESC'
    await without(['enable_bitmapscan', 'enable_sort'], async () => {
      const first = await backward(sql)
      expect(ofType(first.trace, 'index.markDead').flatMap((event) => event.offsets)).toHaveLength(11)
      const second = await backward(sql)
      expect(ofType(second.trace, 'index.markDead')).toEqual([])
      expect(ofType(second.trace, 'heap.tuple')).toHaveLength(990)
    })
  })

  it('a < search for a key a downlink holds goes straight to the leaf left of it', async () => {
    // A downlink's key from the root of orders_pkey: the first id of the leaf it points at.
    const { trace } = await without(['enable_bitmapscan', 'enable_sort'], () =>
      backward('SELECT * FROM orders WHERE id > 49900 ORDER BY id DESC'),
    )
    const root = trace.indexPages.find((page) => page.isRoot)
    const key = root?.items[2].key[0] as string
    const { trace: below } = await without(['enable_bitmapscan', 'enable_sort'], () =>
      backward(`SELECT * FROM orders WHERE id < ${key} ORDER BY id DESC`),
    )
    // The root, then the leaf the downlink before it points at: no leaf to the right first.
    const leaves = indexVisits(below).filter(([, level]) => level === 0)
    expect(leaves[0][0]).toBe(root?.items[1].child)
  })

  it('a lower bound alone starts at the last entry before the NULLs, not at the end of the index', async () => {
    await db.exec(`CREATE TABLE gaps AS SELECT CASE WHEN g <= 5000 THEN g END AS v, repeat('x', 40) AS pad
      FROM generate_series(1, 20000) AS g;
      CREATE INDEX gaps_v_idx ON gaps (v); ANALYZE gaps`)
    try {
      await without(['enable_bitmapscan', 'enable_sort', 'enable_seqscan'], async () => {
        const { result, trace } = await backward('SELECT v FROM gaps WHERE v > 4990 ORDER BY v DESC', 'Index Only Scan')
        expect(result.rows[0][0]).toBe('5000')
        // One leaf: the 15,000 NULLs to its right are never read.
        expect(indexVisits(trace).filter(([, level]) => level === 0)).toHaveLength(1)
      })
    } finally {
      await db.exec('DROP TABLE gaps')
    }
  })

  it('checks a dead first entry’s key all the same, so it knows the page on the left has no matches', async () => {
    // The first entry of a leaf of orders_pkey, made dead by a scan that finds its row deleted.
    const { trace } = await without(['enable_bitmapscan', 'enable_sort'], () =>
      backward('SELECT * FROM orders WHERE id BETWEEN 3000 AND 4000 ORDER BY id DESC'),
    )
    const leaf = trace.indexPages.filter((page) => page.level === 0)[1]
    const first = Number(leaf.items[0].key[0])
    await db.exec(`DELETE FROM order_items WHERE order_id = ${first}; DELETE FROM orders WHERE id = ${first}`)
    await without(['enable_bitmapscan', 'enable_sort'], async () => {
      await backward(`SELECT * FROM orders WHERE id BETWEEN ${first - 50} AND ${first + 50} ORDER BY id DESC`)
      // Now dead: a scan that ends at it reads its leaf only, not the one on its left.
      const { trace: after } = await backward(`SELECT * FROM orders WHERE id > ${first} AND id < ${first + 20} ORDER BY id DESC`)
      expect(after.indexPages.find((page) => page.block === leaf.block)?.items[0].dead).toBe(true)
      expect(indexVisits(after).filter(([, level]) => level === 0)).toEqual([[leaf.block, 0]])
    })
  })

  it('a backward scan of a list of values isn’t replayed yet, and says so', async () => {
    const result = await without(['enable_bitmapscan', 'enable_sort', 'enable_seqscan'], () =>
      run('SELECT * FROM orders WHERE id IN (5, 77, 9000) ORDER BY id DESC'),
    )
    expect(result.plan?.root.backward).toBe(true)
    expect(result.replay).toEqual({
      status: 'unsupported',
      reason: 'Animation isn’t available yet for backward index scans of a list of values or a skip scan.',
    })
  })
})
