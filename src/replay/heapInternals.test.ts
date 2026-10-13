import { PGlite } from '@electric-sql/pglite'
import { pageinspect } from '@electric-sql/pglite/contrib/pageinspect'
import { pg_buffercache } from '@electric-sql/pglite/contrib/pg_buffercache'
import { pg_visibility } from '@electric-sql/pglite/contrib/pg_visibility'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runStatementAt, type RowsResult } from '../db/runner'
import { installExtensions, seedDatabase } from '../db/seed'
import type { Replay } from './replay'
import { MAX_TRACED_ROWS, type HeapPageContents, type Trace, type TraceEvent } from './trace'

/*
 * The heap internals a trace carries for Show internals. Every value is
 * checked against what pageinspect, and pg_visibility (loaded here only, to
 * check the app's own decoding of the map), say. A database of its own:
 * example 9 updates and vacuums orders.
 */

let db: PGlite

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pageinspect, pg_buffercache, pg_visibility } })
  await installExtensions(db)
  await seedDatabase(db)
  await db.exec('CREATE EXTENSION pg_visibility')
}, 120_000)
afterAll(() => db.close())

async function replayed(sql: string): Promise<{ result: RowsResult; trace: Trace }> {
  const [result] = await runStatementAt(db, sql, 0, { emptyCache: true })
  if (result.status !== 'rows') throw new Error(`${sql}: ${JSON.stringify(result).slice(0, 300)}`)
  const replay = result.replay as Replay
  if (replay.status !== 'replayed') throw new Error(`not replayed: ${JSON.stringify(replay).slice(0, 300)}`)
  expect(replay.validation.checks.filter((check) => !check.ok)).toEqual([])
  return { result, trace: replay.trace }
}

function ofType<T extends TraceEvent['type']>(trace: Trace, type: T) {
  return trace.events.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type)
}

/** What Postgres says about one heap page: its header, its bits in the visibility map, and each line pointer. */
async function postgresPage(table: string, block: number) {
  const header = await db.query<{ lower: number; upper: number }>(
    `SELECT lower, upper FROM page_header(get_raw_page('${table}', ${block}))`,
  )
  const vm = await db.query<{ all_visible: boolean; all_frozen: boolean }>(
    `SELECT all_visible, all_frozen FROM pg_visibility_map('${table}', ${block})`,
  )
  const items = await db.query<{
    lp: number
    lp_flags: number
    lp_off: number
    lp_len: number
    t_xmin: string | null
    t_xmax: string | null
    t_ctid: string | null
    t_infomask: number | null
    t_infomask2: number | null
    raw_flags: string[] | null
    combined_flags: string[] | null
  }>(
    `SELECT h.lp, h.lp_flags, h.lp_off, h.lp_len, h.t_xmin::text, h.t_xmax::text, h.t_ctid::text, h.t_infomask, h.t_infomask2,
       f.raw_flags, f.combined_flags
     FROM heap_page_items(get_raw_page('${table}', ${block})) AS h
     LEFT JOIN LATERAL heap_tuple_infomask_flags(h.t_infomask, h.t_infomask2) AS f ON h.t_infomask IS NOT NULL
     ORDER BY h.lp`,
  )
  return { header: header.rows[0], vm: vm.rows[0], items: items.rows }
}

/** Checks each line pointer the trace kept on a page against heap_page_items, and the page's header and map bits. */
async function expectMatchesPostgres(table: string, page: HeapPageContents) {
  const real = await postgresPage(table, page.block)
  expect(page.visibility).toEqual({ allVisible: real.vm.all_visible, allFrozen: real.vm.all_frozen })
  if (page.header === null) return
  expect(page.header).toEqual({ lower: real.header.lower, upper: real.header.upper, linePointers: real.items.length })
  for (const lp of page.linePointers) {
    const item = real.items.find((each) => each.lp === lp.offset)
    expect(item, `lp ${lp.offset} on page ${page.block}`).toBeDefined()
    if (item === undefined) continue
    expect(lp.state).toBe(['unused', 'normal', 'redirect', 'dead'][item.lp_flags])
    expect(lp.length).toBe(item.lp_len)
    if (lp.state === 'redirect') expect(lp.redirectTo).toBe(item.lp_off)
    else if (lp.tupleStart !== null) expect(lp.tupleStart).toBe(item.lp_off)
    if (item.t_xmin === null) {
      expect(lp.header).toBeNull()
      continue
    }
    expect(lp.header).toEqual({
      xmin: Number(item.t_xmin),
      xmax: Number(item.t_xmax),
      ctid: { block: Number(item.t_ctid?.slice(1).split(',')[0]), offset: Number(item.t_ctid?.slice(0, -1).split(',')[1]) },
      infomask: item.t_infomask,
      infomask2: item.t_infomask2,
      flags: item.raw_flags,
      combinedFlags: item.combined_flags,
    })
  }
}

describe('heap internals in the trace', () => {
  it('example 1: the fetched row’s line pointer and tuple header, its page header and map bits, as Postgres has them', async () => {
    const { trace } = await replayed('SELECT * FROM orders WHERE id = 4242')
    const [fetched] = ofType(trace, 'heap.tuple')
    expect(trace.heapPages.map((page) => page.block)).toEqual([fetched.row.block])
    const [page] = trace.heapPages
    expect(page.complete).toBe(true)
    expect(page.linePointers.map((lp) => lp.offset)).toEqual([fetched.row.offset])
    const [lp] = page.linePointers
    expect(lp.state).toBe('normal')
    // The seed was vacuumed: the row's creating transaction is known to have committed, and no one deleted it.
    expect(lp.header?.xmin).toBeGreaterThan(0)
    expect(lp.header?.xmax).toBe(0)
    expect(lp.header?.flags).toContain('HEAP_XMIN_COMMITTED')
    expect(lp.header?.flags).toContain('HEAP_XMAX_INVALID')
    expect(page.visibility?.allVisible).toBe(true)
    await expectMatchesPostgres('orders', page)
  })

  it('example 2: every page the Seq Scan read, with the line pointers of the rows it emitted', async () => {
    const { trace } = await replayed('SELECT * FROM order_items WHERE product_id = 42')
    const reads = ofType(trace, 'buffer.read').map((event) => event.page.block)
    expect(trace.heapPages.map((page) => page.block)).toEqual(reads)
    const emitted = ofType(trace, 'row.emit').map((event) => `(${event.row.block},${event.row.offset})`)
    const kept = trace.heapPages.flatMap((page) => page.linePointers.map((lp) => `(${page.block},${lp.offset})`))
    expect(kept).toEqual(emitted)
    expect(trace.heapPages.every((page) => page.complete && page.header !== null)).toBe(true)
    for (const page of trace.heapPages.filter((each) => each.linePointers.length > 0).slice(0, 5)) {
      await expectMatchesPostgres('order_items', page)
    }
  })

  it(`keeps line pointers for the first ${MAX_TRACED_ROWS} rows only, and says which pages miss some`, async () => {
    const { trace } = await replayed('SELECT * FROM order_items WHERE quantity = 1')
    expect(ofType(trace, 'row.emit').length).toBeGreaterThan(MAX_TRACED_ROWS)
    expect(trace.heapPages.reduce((sum, page) => sum + page.linePointers.length, 0)).toBe(MAX_TRACED_ROWS)
    expect(trace.heapPages[0].complete).toBe(true)
    expect(trace.heapPages.at(-1)?.complete).toBe(false)
    expect(trace.heapPages.at(-1)?.linePointers).toEqual([])
    // Page headers and map bits cost little, so every page has them.
    expect(trace.heapPages.every((page) => page.header !== null && page.visibility !== null)).toBe(true)
  })

  it('example 9: an all-visible page the Index Only Scan skipped has its map bits only; after an UPDATE, the old and new versions', async () => {
    const sql = 'SELECT order_date FROM orders WHERE customer_id = 42'
    const before = await replayed(sql)
    expect(before.trace.heapPages.length).toBeGreaterThan(0)
    for (const page of before.trace.heapPages) {
      expect(page.header).toBeNull()
      expect(page.linePointers).toEqual([])
      expect(page.visibility?.allVisible).toBe(true)
      await expectMatchesPostgres('orders', page)
    }

    await db.exec('UPDATE orders SET total = total WHERE customer_id = 42')
    const after = await replayed(sql)
    const read = after.trace.heapPages.filter((page) => page.header !== null)
    expect(read.length).toBeGreaterThan(0)
    for (const page of read) {
      // The UPDATE cleared the page's bits.
      expect(page.visibility).toEqual({ allVisible: false, allFrozen: false })
      await expectMatchesPostgres('orders', page)
    }
    // Internals are as the query left the pages. Running it pruned the old
    // versions, which no transaction can see any more: their line pointers are
    // dead now. The new versions carry HEAP_UPDATED, and no one has deleted them.
    const lps = new Map(read.map((page) => [page.block, page.linePointers]))
    const fetched = ofType(after.trace, 'heap.tuple')
    const old = fetched.filter((event) => event.visible === null)
    const updated = fetched.filter((event) => event.visible !== null)
    expect(old).toHaveLength(3)
    expect(updated).toHaveLength(3)
    for (const event of old) {
      expect(lps.get(event.row.block)?.find((lp) => lp.offset === event.row.offset)?.state).toBe('dead')
    }
    for (const event of updated) {
      const header = lps.get(event.row.block)?.find((lp) => lp.offset === event.row.offset)?.header
      expect(header?.flags).toContain('HEAP_UPDATED')
      expect(header?.xmax).toBe(0)
    }
  })
})
