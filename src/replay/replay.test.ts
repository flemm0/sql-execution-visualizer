import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt, type RowsResult, type RunOptions } from '../db/runner'
import { seedDatabase } from '../db/seed'
import { CATALOG_NOTE, type Replay } from './replay'
import type { RowRef, Trace, TraceEvent } from './trace'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
}, 120_000)
afterAll(() => db.close())

/** Runs a query as the app does, and returns its result. */
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

/** A table's size in pages. */
async function relpages(table: string) {
  const result = await db.query<{ pages: number }>(
    `SELECT (pg_relation_size($1) / current_setting('block_size')::int)::int AS pages`,
    [table],
  )
  return result.rows[0].pages
}

describe('replaying a Seq Scan', () => {
  it('example 2: reads every page of order_items once and emits the 189 matching rows, as Postgres did', async () => {
    const sql = 'SELECT * FROM order_items WHERE product_id = 42'
    const { result, trace, validation } = await replayed(sql)
    const pages = await relpages('order_items')

    expect(ofType(trace, 'buffer.read').map((event) => event.page.block)).toEqual(
      Array.from({ length: pages }, (_, block) => block),
    )
    expect(ofType(trace, 'buffer.hit')).toEqual([])
    expect(ofType(trace, 'row.emit')).toHaveLength(189)
    expect(result.totalRows).toBe(189)
    expect(trace.events[0]).toEqual({ type: 'node.start', node: 0 })
    expect(trace.events.at(-1)).toEqual({ type: 'node.finish', node: 0 })

    // Each emitted row is the result row at the same position, by its ctid.
    const ctids = await db.query<{ ctid: string }>(`SELECT ctid::text FROM order_items WHERE product_id = 42`)
    expect(ofType(trace, 'row.emit').map((event) => `(${event.row.block},${event.row.offset})`)).toEqual(
      ctids.rows.map((row) => row.ctid),
    )
    expect(ofType(trace, 'row.emit').map((event) => event.resultIndex)).toEqual([...Array(189).keys()])

    expect(validation.checks.map((check) => check.label)).toEqual([
      'Seq Scan on order_items: rows',
      'Seq Scan on order_items: rows removed by filter',
      'Seq Scan on order_items: buffer hits',
      'Seq Scan on order_items: buffer reads',
      'Result: rows',
      'Result: rows with the same values, in the same order',
    ])
    expect(validation.notes).toEqual([])
  })

  it('example 2 with a warm cache: every page is a hit', async () => {
    await run('SELECT * FROM order_items WHERE product_id = 42', {})
    const { trace } = await replayed('SELECT * FROM order_items WHERE product_id = 42', {})
    expect(ofType(trace, 'buffer.read')).toEqual([])
    expect(ofType(trace, 'buffer.hit')).toHaveLength(await relpages('order_items'))
  })

  it('example 11: reads the one page of categories and emits one row', async () => {
    const { trace } = await replayed('SELECT * FROM categories WHERE id = 3')
    const [page] = ofType(trace, 'heap.page')
    expect(ofType(trace, 'heap.page')).toHaveLength(1)
    expect(page).toMatchObject({ page: { block: 0 }, visibleRows: 12, matchedRows: 1 })
    expect(trace.relations.map((relation) => [relation.name, relation.kind, relation.pages])).toEqual([
      ['categories', 'table', 1],
      ['categories_pkey', 'index', 2],
    ])
  })

  it('emits every row when there is no filter, and output expressions over an alias', async () => {
    const all = await replayed('SELECT * FROM categories')
    expect(ofType(all.trace, 'row.emit')).toHaveLength(12)
    expect(all.validation.checks.map((check) => check.label)).not.toContain(
      'Seq Scan on categories: rows removed by filter',
    )

    const { result } = await replayed(`SELECT c.name, upper(c.name) AS loud, c.id * 2 FROM categories c WHERE c.id > 6`)
    expect(result.rows).toHaveLength(6)
  })

  it('counts only the rows the query can see, not deleted or replaced versions', async () => {
    await db.exec(`
      CREATE TABLE notes (id int, body text) WITH (autovacuum_enabled = off);
      INSERT INTO notes SELECT n, 'note ' || n FROM generate_series(1, 100) AS n;
      UPDATE notes SET body = 'changed' WHERE id <= 10;
      DELETE FROM notes WHERE id > 90;
    `)
    const { trace } = await replayed(`SELECT * FROM notes WHERE body = 'changed'`)
    const visible = ofType(trace, 'heap.page').reduce((sum, event) => sum + event.visibleRows, 0)
    expect(visible).toBe(90)
    expect(ofType(trace, 'row.emit')).toHaveLength(10)
    await db.exec('DROP TABLE notes')
  })

  it('reads pages with no visible rows too: a scan doesn’t know a page is empty until it reads it', async () => {
    await db.exec(`
      CREATE TABLE padded (id int, filler text) WITH (autovacuum_enabled = off);
      INSERT INTO padded SELECT n, repeat('x', 500) FROM generate_series(1, 60) AS n;
    `)
    // About 15 rows per page: empty the middle pages and the last one.
    await db.exec(`DELETE FROM padded WHERE (ctid::text::point)[0] IN (1, 2) OR (ctid::text::point)[0] = (
      SELECT max((ctid::text::point)[0]) FROM padded)`)
    const pages = await relpages('padded')
    expect(pages).toBeGreaterThanOrEqual(4)
    const { trace } = await replayed('SELECT id FROM padded WHERE id % 2 = 0')
    expect(ofType(trace, 'heap.page').map((event) => event.visibleRows > 0)).toEqual(
      Array.from({ length: pages }, (_, block) => !(block === 1 || block === 2 || block === pages - 1)),
    )
    await db.exec('DROP TABLE padded')
  })

  it('reads only the table it scans, not tables that inherit from it (ONLY)', async () => {
    await db.exec(`
      CREATE TABLE animals (name text);
      CREATE TABLE dogs () INHERITS (animals);
      INSERT INTO animals VALUES ('generic');
      INSERT INTO dogs VALUES ('rex'), ('fido');
    `)
    const { trace } = await replayed('SELECT * FROM ONLY animals')
    expect(ofType(trace, 'row.emit')).toHaveLength(1)
    await db.exec('DROP TABLE dogs; DROP TABLE animals')
  })

  it('handles names that need quoting', async () => {
    await db.exec(`
      CREATE SCHEMA "Shop Floor";
      CREATE TABLE "Shop Floor"."Bins" ("Bin No" int, "label" text);
      INSERT INTO "Shop Floor"."Bins" SELECT n, 'bin ' || n FROM generate_series(1, 20) AS n;
    `)
    const { result } = await replayed(`SELECT "label" FROM "Shop Floor"."Bins" AS "b b" WHERE "b b"."Bin No" % 5 = 0`)
    expect(result.rows).toEqual([['bin 5'], ['bin 10'], ['bin 15'], ['bin 20']])
    await db.exec('DROP SCHEMA "Shop Floor" CASCADE')
  })

  it('compares the values of the rows shown, and the count of all, for a big result', async () => {
    const { result, validation } = await replayed('SELECT * FROM order_items WHERE quantity > 1', {})
    expect(result.totalRows).toBeGreaterThan(result.rows.length)
    expect(validation.notes).toEqual([
      `Values were compared for the ${result.rows.length.toLocaleString('en-US')} rows shown; the count for all of them.`,
    ])
  })
})

/** A table's ctids for a query's rows, e.g. "(12,3)", in the query's order. */
async function ctidsOf(sql: string) {
  const result = await db.query<{ ctid: string }>(sql)
  return result.rows.map((row) => row.ctid)
}

function text(row: { block: number; offset: number }) {
  return `(${row.block},${row.offset})`
}

/** An index's B-tree root page and its level, from pageinspect. */
async function btree(index: string) {
  const meta = await db.query<{ root: number; level: number }>(`SELECT root::int, level::int FROM bt_metap('${index}')`)
  return meta.rows[0]
}

/** Runs `body` with some of the planner's choices turned off (e.g. "enable_bitmapscan"), so it picks the plan a test is about. */
async function without<T>(settings: string[], body: () => Promise<T>): Promise<T> {
  await db.exec(settings.map((setting) => `SET ${setting} = off;`).join(' '))
  try {
    return await body()
  } finally {
    await db.exec(settings.map((setting) => `RESET ${setting};`).join(' '))
  }
}

describe('replaying an Index Scan', () => {
  it('example 1: searches from the root to one leaf, and fetches one heap row', async () => {
    const sql = 'SELECT * FROM orders WHERE id = 4242'
    const { result, trace, validation } = await replayed(sql)
    const [orders, , pkey] = trace.relations
    const { root } = await btree('orders_pkey')
    const [ctid] = await ctidsOf(`SELECT ctid::text FROM orders WHERE id = 4242`)
    const [leaf] = ofType(trace, 'index.visit').slice(1)

    expect(result.plan?.root.title).toBe('Index Scan using orders_pkey on orders')
    expect(trace.events.map((event) => event.type)).toEqual([
      'node.start',
      'index.search',
      'buffer.read', // the root
      'index.visit',
      'buffer.read', // one leaf
      'index.visit',
      'index.entry',
      'buffer.read', // one heap page
      'heap.tuple',
      'row.emit',
      'node.finish',
    ])
    expect(ofType(trace, 'index.visit').map((event) => [event.page.relation, event.page.block, event.level])).toEqual([
      [pkey.id, root, 1],
      [pkey.id, leaf.page.block, 0],
    ])
    // The root's downlink points at the leaf.
    const [downlink] = await db.query<{ ctid: string }>(
      `SELECT ctid::text FROM bt_page_items('orders_pkey', ${root}) WHERE itemoffset = ${ofType(trace, 'index.visit')[0].downlink}`,
    ).then((found) => found.rows)
    expect(downlink.ctid).toMatch(new RegExp(`^\\(${leaf.page.block},`))
    const [entry] = ofType(trace, 'index.entry')
    expect(entry).toMatchObject({ key: ['4242'], page: { relation: pkey.id, block: leaf.page.block } })
    expect(text(entry.row)).toBe(ctid)
    expect(ofType(trace, 'heap.tuple')[0]).toEqual({ type: 'heap.tuple', node: 0, row: entry.row, visible: entry.row, matched: true })
    expect(ofType(trace, 'buffer.read')[2].page).toEqual({ relation: orders.id, block: entry.row.block })

    expect(validation.checks.map((check) => check.label)).toEqual([
      'Index Scan using orders_pkey on orders: rows',
      'Index Scan using orders_pkey on orders: index searches',
      'Index Scan using orders_pkey on orders: buffer hits',
      'Index Scan using orders_pkey on orders: buffer reads',
      'Result: rows',
      'Result: rows with the same values, in the same order',
    ])
  })

  it('example 4: walks right along 4 leaves, and reads each of 13 heap pages once, in index order', async () => {
    const { trace } = await replayed('SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000')
    const pkey = trace.relations[2]
    const reads = ofType(trace, 'buffer.read')
    expect(reads).toHaveLength(18)
    expect(ofType(trace, 'buffer.hit')).toEqual([])
    const indexReads = reads.filter((event) => event.page.relation === pkey.id)
    expect(indexReads).toHaveLength(5)

    // Each leaf after the first is the right neighbor of the one before.
    const leaves = ofType(trace, 'index.visit').filter((event) => event.level === 0).map((event) => event.page.block)
    expect(leaves).toHaveLength(4)
    for (let i = 1; i < leaves.length; i++) {
      const stats = await db.query<{ next: number }>(`SELECT btpo_next::int AS next FROM bt_page_stats('orders_pkey', ${leaves[i - 1]})`)
      expect(stats.rows[0].next).toBe(leaves[i])
    }

    const emitted = ofType(trace, 'row.emit')
    expect(emitted.map((event) => text(event.row))).toEqual(
      await ctidsOf('SELECT ctid::text FROM orders WHERE id BETWEEN 1000 AND 2000 ORDER BY id'),
    )
    expect(ofType(trace, 'index.entry').map((event) => event.key[0])).toEqual(
      Array.from({ length: 1001 }, (_, i) => String(1000 + i)),
    )
  })

  it('with a warm cache, every page is a hit', async () => {
    await run('SELECT * FROM orders WHERE id = 4242', {})
    const { trace } = await replayed('SELECT * FROM orders WHERE id = 4242', {})
    expect(ofType(trace, 'buffer.read')).toEqual([])
    expect(ofType(trace, 'buffer.hit')).toHaveLength(3)
  })

  it('goes down every level of a 3-level index (order_items_pkey)', async () => {
    const { trace } = await replayed('SELECT * FROM order_items WHERE order_id = 777 AND line_no > 1')
    expect(ofType(trace, 'index.visit').map((event) => event.level)).toEqual([2, 1, 0])
    expect(ofType(trace, 'index.entry').every((event) => event.key[0] === '777' && Number(event.key[1]) > 1)).toBe(true)
  })

  it('fetches rows that fail the Filter too, and counts them as removed', async () => {
    const { trace, validation } = await replayed(
      `SELECT * FROM orders WHERE id BETWEEN 49000 AND 49500 AND status = 'pending'`,
    )
    const tuples = ofType(trace, 'heap.tuple')
    expect(tuples).toHaveLength(501)
    const passed = tuples.filter((event) => event.matched).length
    expect(passed).toBeGreaterThan(0)
    expect(passed).toBeLessThan(501)
    expect(ofType(trace, 'row.emit')).toHaveLength(passed)
    expect(validation.checks.find((check) => check.label.endsWith('rows removed by filter'))).toMatchObject({
      replay: 501 - passed,
      ok: true,
    })
  })

  it('stops at a high key past the range, and goes right of a downlink equal to the start key', async () => {
    // The root's second downlink: the first key of the second leaf (a 4-byte integer).
    const { root } = await btree('orders_pkey')
    const second = await db.query<{ data: string }>(`SELECT data FROM bt_page_items('orders_pkey', ${root}) WHERE itemoffset = 2`)
    const key = parseInt(second.rows[0].data.split(' ').slice(0, 4).reverse().join(''), 16)

    // Every entry of the first leaf matches; its high key says the next one can't.
    const first = await replayed(`SELECT * FROM orders WHERE id BETWEEN 1 AND ${key - 1}`)
    expect(ofType(first.trace, 'index.visit').map((event) => event.level)).toEqual([1, 0])
    expect(ofType(first.trace, 'row.emit')).toHaveLength(key - 1)
    // Starting at the second leaf's first key, the search goes straight to the second leaf.
    const next = await replayed(`SELECT * FROM orders WHERE id BETWEEN ${key} AND ${key + 5}`)
    const visits = ofType(next.trace, 'index.visit')
    expect(visits.map((event) => event.level)).toEqual([1, 0])
    expect(visits[0].downlink).toBe(2)
  })

  it('finds nothing past the last key, and nothing in a contradiction, as Postgres does', async () => {
    const past = await replayed('SELECT * FROM orders WHERE id > 50000')
    expect(ofType(past.trace, 'row.emit')).toEqual([])
    const none = await replayed('SELECT * FROM orders WHERE id > 3000 AND id < 2000')
    expect(ofType(none.trace, 'row.emit')).toEqual([])
  })

  it('walks the whole index for its order when there is no condition', async () => {
    const { trace } = await replayed('SELECT * FROM products ORDER BY id')
    expect(ofType(trace, 'row.emit')).toHaveLength(1000)
    expect(ofType(trace, 'index.visit').filter((event) => event.level === 0)).toHaveLength(3)
  })

  it('compares text keys with the column’s collation, in a multi-column index', async () => {
    const { trace } = await without(['enable_bitmapscan'], () =>
      replayed(`SELECT * FROM customers WHERE last_name = 'Smith' AND first_name >= 'K'`),
    )
    const keys = ofType(trace, 'index.entry').map((event) => event.key)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every(([last, first]) => last === 'Smith' && (first as string) >= 'K')).toBe(true)

    await db.exec(`
      CREATE TABLE words (word text COLLATE "unicode", n int);
      INSERT INTO words SELECT w, n FROM unnest(ARRAY['apple', 'Banana', 'cherry', 'Date', 'éclair']) AS w, generate_series(1, 300) AS n;
      CREATE INDEX words_word_idx ON words (word);
      ANALYZE words;
    `)
    // In the database's own collation, "C", uppercase sorts before lowercase and é after every
    // ASCII letter. In "unicode", the order is apple, Banana, cherry, Date, éclair.
    const words = await without(['enable_seqscan', 'enable_bitmapscan'], () =>
      replayed(`SELECT * FROM words WHERE word > 'Date' AND word < 'f'`),
    )
    await db.exec('DROP TABLE words')
    expect(new Set(ofType(words.trace, 'index.entry').map((event) => event.key[0]))).toEqual(new Set(['éclair']))
  })

  it('reads keys of other types: bigint, timestamp, timestamptz, date, varchar, boolean', async () => {
    await db.exec(`
      CREATE TABLE typed (big bigint, at timestamp, at_tz timestamptz, day date, code varchar(20), small int2, flag bool);
      INSERT INTO typed SELECT n * 10000000000, TIMESTAMP '2024-01-02 03:04:05.678' + n * INTERVAL '1 hour 1 second',
        TIMESTAMPTZ '1999-12-31 23:00:00.000001+02' + n * INTERVAL '1 day', DATE '1999-12-25' + n, 'v' || n, n % 300, n % 2 = 0
      FROM generate_series(1, 3000) AS n;
      CREATE INDEX ON typed (big); CREATE INDEX ON typed (at); CREATE INDEX ON typed (at_tz); CREATE INDEX ON typed (day);
      CREATE INDEX ON typed (code); CREATE INDEX ON typed (small, flag);
      ANALYZE typed;
    `)
    const queries = [
      'SELECT * FROM typed WHERE big BETWEEN 70000000000 AND 90000000000',
      `SELECT * FROM typed WHERE at > '2024-04-01' AND at < '2024-04-03'`,
      `SELECT * FROM typed WHERE at_tz < '2000-01-05'`,
      `SELECT * FROM typed WHERE day = '2000-01-01'`,
      `SELECT * FROM typed WHERE code = 'v1234'`,
      'SELECT * FROM typed WHERE small = 8 AND flag',
    ]
    for (const sql of queries) {
      const { result } = await without(['enable_bitmapscan'], () => replayed(sql))
      expect(result.plan?.root.nodeType, sql).toBe('Index Scan')
      expect(result.totalRows, sql).toBeGreaterThan(0)
    }
    await db.exec('DROP TABLE typed')
  })

  it('handles one key on many leaf pages, where downlinks keep a heap row to tell pages apart', async () => {
    await db.exec(`
      CREATE TABLE repeated (v int, n int) WITH (autovacuum_enabled = off);
      INSERT INTO repeated SELECT v, n FROM unnest(ARRAY[7, 8, 9]) AS v, generate_series(1, 2000) AS n;
      CREATE INDEX repeated_v_idx ON repeated (v) WITH (deduplicate_items = off);
      ANALYZE repeated;
    `)
    const { result } = await replayed('SELECT * FROM repeated WHERE v = 8')
    expect(result.totalRows).toBe(2000)
    // > starts after every 7, not at the first page of 7s.
    const after = await replayed('SELECT * FROM repeated WHERE v > 7 AND v < 9')
    expect(ofType(after.trace, 'index.entry')[0].key).toEqual(['8'])
    await db.exec('DROP TABLE repeated')
  })

  it('follows a row updated in place (HOT) to its new version, and skips a deleted row’s', async () => {
    await db.exec(`
      CREATE TABLE stock (id int PRIMARY KEY, count int) WITH (fillfactor = 50, autovacuum_enabled = off);
      INSERT INTO stock SELECT n, 0 FROM generate_series(1, 500) AS n;
      UPDATE stock SET count = 1 WHERE id BETWEEN 10 AND 12;
      DELETE FROM stock WHERE id = 20;
    `)
    const { trace } = await without(['enable_bitmapscan'], () => replayed('SELECT * FROM stock WHERE id BETWEEN 8 AND 22'))
    const tuples = ofType(trace, 'heap.tuple')
    expect(tuples).toHaveLength(15)
    const moved = tuples.filter((event) => event.visible !== null && text(event.visible) !== text(event.row))
    expect(moved).toHaveLength(3)
    expect(tuples.filter((event) => event.visible === null)).toHaveLength(1)
    expect(ofType(trace, 'row.emit').map((event) => text(event.row))).toEqual(
      await ctidsOf('SELECT ctid::text FROM stock WHERE id BETWEEN 8 AND 22 ORDER BY id'),
    )

    // Those versions were tidied up ("pruned") by the first scan after the
    // update, so the entry's line pointer redirects to the new version. In the
    // updating transaction, nothing is pruned yet: the scan follows the chain
    // from the old version to the new.
    await db.exec('BEGIN; UPDATE stock SET count = 2 WHERE id = 30')
    const chained = await without(['enable_bitmapscan'], () => replayed('SELECT * FROM stock WHERE id = 30'))
    await db.exec('ROLLBACK')
    const [tuple] = ofType(chained.trace, 'heap.tuple')
    expect(tuple.visible).not.toBeNull()
    expect(text(tuple.visible as RowRef)).not.toBe(text(tuple.row))
    await db.exec('DROP TABLE stock')
  })

  it('replays the first scan after a delete, which marks the deleted rows’ entries dead; the next skips them', async () => {
    await db.exec(`
      CREATE TABLE tickets (id int PRIMARY KEY, note text) WITH (autovacuum_enabled = off);
      INSERT INTO tickets SELECT n, 'ticket ' || n FROM generate_series(1, 2000) AS n;
      DELETE FROM tickets WHERE id BETWEEN 100 AND 104;
    `)
    const sql = 'SELECT * FROM tickets WHERE id BETWEEN 90 AND 110'
    const first = await without(['enable_bitmapscan'], () => replayed(sql))
    expect(ofType(first.trace, 'heap.tuple').filter((event) => event.visible === null)).toHaveLength(5)
    const [marked] = ofType(first.trace, 'index.markDead')
    expect(marked.offsets).toHaveLength(5)
    // Marking them dead takes another look at the leaf page, after its rows were fetched.
    const types = first.trace.events.map((event) => event.type)
    expect(types.slice(types.indexOf('index.markDead') - 1)).toEqual(['buffer.hit', 'index.markDead', 'node.finish'])

    const second = await without(['enable_bitmapscan'], () => replayed(sql))
    expect(ofType(second.trace, 'heap.tuple')).toHaveLength(16)
    expect(ofType(second.trace, 'index.markDead')).toEqual([])
    await db.exec('DROP TABLE tickets')
  })

  it('inside a transaction block, sees the visitor’s own uncommitted changes and leaves the transaction usable', async () => {
    await db.exec('BEGIN; DELETE FROM order_items WHERE order_id = 4242; DELETE FROM orders WHERE id = 4242')
    const { result, trace } = await replayed('SELECT * FROM orders WHERE id BETWEEN 4240 AND 4244')
    expect(result.totalRows).toBe(4)
    // Deleted, but not yet committed: not visible, and not dead for everyone, so not marked.
    expect(ofType(trace, 'heap.tuple').filter((event) => event.visible === null)).toHaveLength(1)
    expect(ofType(trace, 'index.markDead')).toEqual([])
    await db.exec('ROLLBACK')
    const { result: after } = await replayed('SELECT * FROM orders WHERE id BETWEEN 4240 AND 4244')
    expect(after.totalRows).toBe(5)
  })
})

describe('replaying an Index Scan with a list of values, or a skip scan', () => {
  // A session's first scan of a kind also looks things up in the system
  // catalogs (the operators for a pair of types, whether a type can count
  // up), and Postgres counts those page accesses as the scan's. The replay
  // doesn't model them, so run each kind once first.
  beforeAll(async () => {
    await without(['enable_seqscan', 'enable_bitmapscan'], async () => {
      await run(`SELECT * FROM orders WHERE id = ANY ('{1,2}')`)
      await run(`SELECT * FROM orders WHERE id = ANY ('{1,2}'::bigint[])`)
      await run(`SELECT * FROM orders WHERE customer_id > 9990 AND order_date < '2022-06-01'`)
      await run(`SELECT * FROM customers WHERE last_name > 'Y' AND first_name = 'Mary'`)
    })
  })

  /** For each search down from the root, the first page it reads. */
  function searchStarts(trace: Trace) {
    const starts: number[] = []
    trace.events.forEach((event, i) => {
      if (event.type !== 'index.search') return
      const visit = trace.events.slice(i).find((later) => later.type === 'index.visit')
      if (visit?.type === 'index.visit') starts.push(visit.page.block)
    })
    return starts
  }

  it('searches again from the root for a value of the list that isn’t on the leaf it’s reading', async () => {
    const { trace } = await replayed(`SELECT * FROM orders WHERE id = ANY ('{9000,5,77}')`)
    // 5 and 77 are on the first leaf page; 9000 is many pages to the right.
    const { root } = await btree('orders_pkey')
    expect(searchStarts(trace)).toEqual([root, root])
    expect(ofType(trace, 'index.entry').map((event) => event.key)).toEqual([['5'], ['77'], ['9000']])
    expect(ofType(trace, 'row.emit').map((event) => text(event.row))).toEqual(
      await ctidsOf('SELECT ctid::text FROM orders WHERE id IN (5, 77, 9000) ORDER BY id'),
    )
  })

  it('sorts the list, drops duplicates and NULLs, compares across types, and searches nothing for an empty list', async () => {
    const { trace } = await replayed(`SELECT * FROM orders WHERE id = ANY ('{9000,5,NULL,5,99999999999}'::bigint[])`)
    expect(ofType(trace, 'index.entry').map((event) => event.key)).toEqual([['5'], ['9000']])
    // 99999999999 is past every key, but finding that out takes a search too.
    expect(ofType(trace, 'index.search')).toHaveLength(3)

    const empty = await replayed(`SELECT * FROM orders WHERE id = ANY ('{}'::integer[])`)
    expect(ofType(empty.trace, 'index.search')).toEqual([])
    expect(ofType(empty.trace, 'index.visit')).toEqual([])
  })

  it('lists on two columns move together: each pair of values in index order', async () => {
    const { trace } = await without(['enable_bitmapscan'], () =>
      replayed(
        `SELECT * FROM customers WHERE last_name IN ('Stewart', 'Robertson', 'Grant') AND first_name IN ('Patrick', 'Barbara', 'Sven')`,
      ),
    )
    const keys = ofType(trace, 'index.entry').map((event) => event.key)
    const expected = await db.query<{ last_name: string; first_name: string }>(
      `SELECT last_name, first_name FROM customers
       WHERE last_name IN ('Stewart', 'Robertson', 'Grant') AND first_name IN ('Patrick', 'Barbara', 'Sven')
       ORDER BY last_name, first_name`,
    )
    expect(keys.length).toBeGreaterThan(5)
    expect(keys).toEqual(expected.rows.map((row) => [row.last_name, row.first_name]))
  })

  it('example 8: skips through every last name to find first_name = ’Mary’, though the index starts with last_name', async () => {
    await without(['enable_seqscan', 'enable_bitmapscan'], async () => {
      const { result, trace } = await replayed(`SELECT * FROM customers WHERE first_name = 'Mary'`)
      const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE first_name = 'Mary'`)
      expect(result.totalRows).toBe(count.rows[0].n)
      expect(ofType(trace, 'index.entry').every((event) => event.key[1] === 'Mary')).toBe(true)
    })
  })

  it('a skip scan over a column that counts up: one search per value, into the NULLs too', async () => {
    await db.exec(`
      CREATE TABLE grid (a int, b int, note text) WITH (autovacuum_enabled = off);
      INSERT INTO grid SELECT n % 10, n / 10, 'cell ' || n FROM generate_series(0, 19999) AS n;
      INSERT INTO grid SELECT NULL, NULL, 'blank' FROM generate_series(1, 300);
      CREATE INDEX grid_a_b_idx ON grid (a, b);
      ANALYZE grid;
    `)
    await without(['enable_seqscan', 'enable_bitmapscan'], async () => {
      const { trace } = await replayed('SELECT * FROM grid WHERE b = 5')
      const { root } = await btree('grid_a_b_idx')
      const starts = searchStarts(trace)
      expect(starts.length).toBeGreaterThan(10)
      expect(new Set(starts)).toEqual(new Set([root]))
      expect(ofType(trace, 'index.entry').map((event) => event.key)).toEqual(
        Array.from({ length: 10 }, (_, a) => [String(a), '5']),
      )

      // A range on the skipped column bounds the values it goes through.
      const ranged = await replayed('SELECT * FROM grid WHERE a > 6 AND b = 5')
      expect(ofType(ranged.trace, 'index.entry').map((event) => event.key[0])).toEqual(['7', '8', '9'])
      expect(ofType(ranged.trace, 'index.search').length).toBeLessThan(starts.length)
    })

    // Reading on from the end of one value of a into the start of the next,
    // b starts low again, below the range: (4, 0) has the note, but b is out.
    await db.exec('DROP INDEX grid_a_b_idx; DELETE FROM grid WHERE a IS NULL')
    await db.exec('VACUUM grid')
    await db.exec('CREATE INDEX grid_a_b_note_idx ON grid (a, b, note); ANALYZE grid')
    await without(['enable_seqscan', 'enable_bitmapscan', 'enable_indexonlyscan'], async () => {
      const { result } = await replayed(`SELECT * FROM grid WHERE b > 1995 AND note = 'cell 4'`)
      expect(result.totalRows).toBe(0)
    })
    await db.exec('DROP TABLE grid')
  })

  it('explains the extra buffer hits of a session’s first skip scan over a type: Postgres reads system catalogs', async () => {
    await db.exec(`
      CREATE TABLE readings (sensor bigint, n int) WITH (autovacuum_enabled = off);
      INSERT INTO readings SELECT s, n FROM generate_series(1, 5) AS s, generate_series(1, 2000) AS n;
      CREATE INDEX readings_sensor_n_idx ON readings (sensor, n);
      ANALYZE readings;
    `)
    await without(['enable_seqscan', 'enable_bitmapscan', 'enable_indexonlyscan'], async () => {
      const sql = 'SELECT * FROM readings WHERE n = 7'
      // No earlier test skip-scans a bigint column.
      const first = (await run(sql)).replay
      if (first?.status !== 'replayed') throw new Error(JSON.stringify(first))
      expect(first.validation.checks.filter((check) => !check.ok).map((check) => check.label)).toEqual([
        'Index Scan using readings_sensor_n_idx on readings: buffer hits',
      ])
      expect(first.validation.notes).toContain(CATALOG_NOTE)

      const again = await replayed(sql)
      expect(again.validation.notes).not.toContain(CATALOG_NOTE)
    })
    await db.exec('DROP TABLE readings')
  })

  it('the first scan after a delete marks dead entries before it searches again; the next skips them', async () => {
    await db.exec(`
      CREATE TABLE seats (id int PRIMARY KEY, row_name text) WITH (autovacuum_enabled = off);
      INSERT INTO seats SELECT n, 'row ' || (n / 20) FROM generate_series(1, 5000) AS n;
      DELETE FROM seats WHERE id IN (3, 13);
    `)
    const sql = `SELECT * FROM seats WHERE id = ANY ('{3,13,23,4003}')`
    const first = await without(['enable_bitmapscan'], () => replayed(sql))
    const types = first.trace.events.map((event) => event.type)
    const [marked] = ofType(first.trace, 'index.markDead')
    expect(marked.offsets).toHaveLength(2)
    // Leaving the first leaf for a new search from the root: the dead entries are marked first.
    expect(types.indexOf('index.markDead')).toBeLessThan(types.lastIndexOf('index.search'))
    expect(ofType(first.trace, 'index.search')).toHaveLength(2)

    const second = await without(['enable_bitmapscan'], () => replayed(sql))
    expect(ofType(second.trace, 'index.markDead')).toEqual([])
    expect(ofType(second.trace, 'heap.tuple')).toHaveLength(2)
    await db.exec('DROP TABLE seats')
  })
})

describe('a replay that can’t match', () => {
  it('a volatile filter picks other rows each time, and the validator says so', async () => {
    // random() is evaluated anew by EXPLAIN ANALYZE, the query, and the replay's own query.
    const replay = (await run('SELECT * FROM products WHERE random() < 0.5')).replay
    if (replay?.status !== 'replayed') throw new Error('not replayed')
    expect(replay.validation.ok).toBe(false)
    const failed = replay.validation.checks.filter((check) => !check.ok).map((check) => check.label)
    expect(failed).toContain('Result: rows with the same values, in the same order')
  })
})

describe('a query the replay engine can’t replay yet', () => {
  async function reason(sql: string) {
    const replay = (await run(sql)).replay
    return replay?.status === 'unsupported' ? replay.reason : JSON.stringify(replay).slice(0, 200)
  }

  it('says which node type isn’t supported', async () => {
    expect(await reason('SELECT count(*) FROM categories')).toBe('Animation isn’t available yet for Aggregate.')
  })

  it('says which kind of index scan isn’t supported', async () => {
    await without(['enable_seqscan', 'enable_bitmapscan'], async () => {
      expect(await reason(`SELECT * FROM orders WHERE id < ANY ('{5,77}')`)).toBe(
        `Animation isn’t available yet for the index condition orders.id < ANY ('{5,77}'::integer[]).`,
      )
      expect(await reason('SELECT * FROM orders WHERE id < 100 ORDER BY id DESC')).toBe(
        'Animation isn’t available yet for backward index scans.',
      )
    })
  })

  it('says a temporary table can’t be animated', async () => {
    await db.exec('CREATE TEMP TABLE scratch AS SELECT 1 AS a')
    expect(await reason('SELECT * FROM scratch')).toBe(
      'Animation isn’t available for temporary tables, which Postgres keeps outside shared buffers.',
    )
  })

  it('has no replay for a statement without a plan', async () => {
    expect((await run('SHOW block_size')).replay).toBeNull()
  })
})
