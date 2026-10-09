import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import { seedDatabase } from './seed'

// These tests pin down how PGlite's Postgres counts buffer hits and reads, which
// the replay engine (M2) has to reproduce exactly. The findings and the order of
// steps they lead to are in docs/decisions/0022-replay-pipeline-placement-and-buffer-counts.md.

type Database = Awaited<ReturnType<typeof createDatabase>>

interface BufferCounts {
  hit: number
  read: number
}

interface ExplainNode {
  'Node Type': string
  'Shared Hit Blocks': number
  'Shared Read Blocks': number
}

/**
 * Replays the heap page accesses of an index scan: `pages` is the heap page of
 * each row, in the order the index returns them. The executor keeps a page pinned
 * while consecutive rows are on it, so only moving to another page is an access.
 * An access is a hit if the page was cached beforehand or already read in this scan.
 */
function countHeapAccesses(pages: number[], cachedBefore: Set<number>): BufferCounts {
  const cached = new Set(cachedBefore)
  const counts = { hit: 0, read: 0 }
  let previous: number | null = null
  for (const page of pages) {
    if (page === previous) continue
    if (cached.has(page)) {
      counts.hit++
    } else {
      counts.read++
      cached.add(page)
    }
    previous = page
  }
  return counts
}

describe('buffer hits and reads', () => {
  let db: Database

  beforeAll(async () => {
    db = await createDatabase()
    await seedDatabase(db)
  }, 120_000)
  afterAll(() => db.close())

  async function evict(...relations: string[]) {
    for (const relation of relations) await db.query(`SELECT pg_buffercache_evict_relation('${relation}')`)
  }

  /** The block numbers of a relation's main data that are in shared buffers. */
  async function cachedPages(relation: string) {
    const result = await db.query<{ page: number }>(`
      SELECT relblocknumber AS page FROM pg_buffercache
      WHERE relfilenode = pg_relation_filenode('${relation}') AND relforknumber = 0
    `)
    return new Set(result.rows.map((row) => row.page))
  }

  /** The buffer counts EXPLAIN ANALYZE reports for the plan's top node (planning not included). */
  async function executionCounts(sql: string) {
    const result = await db.query<{ 'QUERY PLAN': { Plan: ExplainNode }[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    )
    const node = result.rows[0]['QUERY PLAN'][0].Plan
    return { type: node['Node Type'], hit: node['Shared Hit Blocks'], read: node['Shared Read Blocks'] }
  }

  /** The heap page of each row of `SELECT ... FROM orders WHERE <where> ORDER BY <order>`. */
  async function heapPagesOfOrders(where: string, order: string) {
    const result = await db.query<{ page: number }>(
      `SELECT (ctid::text::point)[0]::int AS page FROM orders WHERE ${where} ORDER BY ${order}`,
    )
    return result.rows.map((row) => row.page)
  }

  it('empties a table from the cache with pg_buffercache_evict_relation', async () => {
    await db.query('SELECT count(*) FROM orders')
    expect((await cachedPages('orders')).size).toBeGreaterThan(0)

    await evict('orders')
    expect((await cachedPages('orders')).size).toBe(0)
  })

  it('reads every heap page once in a Seq Scan, then finds them all cached (example 2)', async () => {
    await evict('order_items')
    const sql = 'SELECT * FROM order_items WHERE product_id = 42'
    const pages = await db.query<{ relpages: number }>(`SELECT relpages FROM pg_class WHERE relname = 'order_items'`)
    const heapPages = pages.rows[0].relpages

    expect(await executionCounts(sql)).toEqual({ type: 'Seq Scan', hit: 0, read: heapPages })
    expect(await executionCounts(sql)).toEqual({ type: 'Seq Scan', hit: heapPages, read: 0 })
  })

  it('reads one page of a one-page table (example 11)', async () => {
    await evict('categories', 'categories_pkey')
    expect(await executionCounts('SELECT * FROM categories WHERE id = 3')).toEqual({ type: 'Seq Scan', hit: 0, read: 1 })
  })

  it('reads the B-tree root, one leaf and one heap page for a primary-key lookup (example 1)', async () => {
    const sql = 'SELECT * FROM orders WHERE id = 4242'
    await db.query(`EXPLAIN ${sql}`) // planning reads the index's metapage the first time
    await evict('orders', 'orders_pkey')

    expect(await executionCounts(sql)).toEqual({ type: 'Index Scan', hit: 0, read: 3 })
    const [page] = await heapPagesOfOrders('id = 4242', 'id')
    expect(await cachedPages('orders')).toEqual(new Set([page]))
    expect((await cachedPages('orders_pkey')).size).toBe(2) // no metapage during execution
  })

  it('reads each heap page of a range once when the rows are in index order (example 4)', async () => {
    const sql = 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000'
    await db.query(`EXPLAIN ${sql}`)
    await evict('orders', 'orders_pkey')

    const counts = await executionCounts(sql)
    const heap = countHeapAccesses(await heapPagesOfOrders('id BETWEEN 1000 AND 2000', 'id'), new Set())
    const indexPagesRead = (await cachedPages('orders_pkey')).size
    expect(heap).toEqual({ hit: 0, read: 13 })
    expect(counts).toEqual({ type: 'Index Scan', hit: 0, read: heap.read + indexPagesRead })
  })

  describe('an index scan over rows scattered across the heap', () => {
    const where = 'customer_id BETWEEN 1 AND 100'
    const sql = `SELECT * FROM orders WHERE ${where}`

    beforeAll(async () => {
      // Without these the planner picks a Bitmap Heap Scan, which reads each page once.
      await db.exec('SET enable_bitmapscan = off; SET enable_seqscan = off')
    })
    afterAll(async () => {
      await db.exec('RESET enable_bitmapscan; RESET enable_seqscan')
    })

    it('loads index pages while planning, before execution starts', async () => {
      await evict('orders', 'orders_customer_id_order_date_idx')
      await db.query(`EXPLAIN ${sql}`)
      // The planner probes the index for the real minimum, since 1 is at the low end.
      expect((await cachedPages('orders_customer_id_order_date_idx')).size).toBeGreaterThan(0)
    })

    it('matches the replayed counts when the cache is snapshotted after planning', async () => {
      await evict('orders', 'orders_customer_id_order_date_idx')
      await db.query(`EXPLAIN ${sql}`)
      const heapBefore = await cachedPages('orders')
      const indexBefore = await cachedPages('orders_customer_id_order_date_idx')

      const counts = await executionCounts(sql)
      const indexAfter = await cachedPages('orders_customer_id_order_date_idx')
      const indexRead = [...indexAfter].filter((page) => !indexBefore.has(page)).length
      // The scan visits the root and the leaves the range spans: here root + 2 leaves,
      // all of them cached now, since the index started out evicted.
      expect(indexAfter.size).toBe(3)
      const indexHit = indexAfter.size - indexRead
      const heap = countHeapAccesses(await heapPagesOfOrders(where, 'customer_id, order_date, ctid'), heapBefore)

      expect(heap.hit).toBeGreaterThan(0) // some heap pages are visited more than once
      expect(counts).toEqual({ type: 'Index Scan', hit: heap.hit + indexHit, read: heap.read + indexRead })
    })

    it('counts a hit on a partly warm cache for pages that were already cached', async () => {
      await evict('orders', 'orders_customer_id_order_date_idx')
      await db.query('SELECT * FROM orders WHERE id BETWEEN 1 AND 4000') // warms some heap pages
      await db.query(`EXPLAIN ${sql}`)
      const heapBefore = await cachedPages('orders')
      const indexBefore = await cachedPages('orders_customer_id_order_date_idx')

      const counts = await executionCounts(sql)
      const indexAfter = await cachedPages('orders_customer_id_order_date_idx')
      const indexRead = [...indexAfter].filter((page) => !indexBefore.has(page)).length
      const heap = countHeapAccesses(await heapPagesOfOrders(where, 'customer_id, order_date, ctid'), heapBefore)

      expect(counts).toEqual({ type: 'Index Scan', hit: heap.hit + 3 - indexRead, read: heap.read + indexRead })
    })
  })

  it('restores the cache after pageinspect reads by evicting the buffers it added', async () => {
    const relations = ['orders', 'orders_pkey']
    const snapshot = async () => {
      const result = await db.query<{ bufferid: number; key: string }>(`
        SELECT bufferid, relfilenode || '/' || relforknumber || '/' || relblocknumber AS key FROM pg_buffercache
        WHERE relfilenode IN (SELECT pg_relation_filenode(name) FROM unnest($1::text[]) AS name)
      `, [relations])
      return result.rows
    }
    await evict(...relations)
    await db.query('SELECT * FROM orders WHERE id = 4242')
    const before = await snapshot()

    await db.query(`SELECT * FROM heap_page_items(get_raw_page('orders', 0))`)
    await db.query(`SELECT * FROM bt_page_items('orders_pkey', 1)`)
    const keep = new Set(before.map((buffer) => buffer.key))
    const added = (await snapshot()).filter((buffer) => !keep.has(buffer.key))
    expect(added.length).toBeGreaterThan(0)

    for (const buffer of added) await db.query('SELECT pg_buffercache_evict($1)', [buffer.bufferid])
    const keys = (rows: { key: string }[]) => rows.map((row) => row.key).sort()
    expect(keys(await snapshot())).toEqual(keys(before))
  })
})
