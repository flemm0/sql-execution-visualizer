import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt, type RowsResult, type RunOptions } from '../db/runner'
import { seedDatabase } from '../db/seed'
import type { Replay } from './replay'
import type { Trace, TraceEvent } from './trace'

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
    expect(await reason('SELECT * FROM orders WHERE id = 4242')).toBe('Animation isn’t available yet for Index Scan.')
    expect(await reason('SELECT count(*) FROM categories')).toBe('Animation isn’t available yet for Aggregate.')
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
