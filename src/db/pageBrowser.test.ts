import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import { evictRelations, findRelations, snapshotCache } from './inspector'
import { readIndexPage, readTablePage, type IndexPageView } from './pageBrowser'
import { seedDatabase } from './seed'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
  // Tables of the tests' own, so the seed tables stay as generated.
  await db.exec(`
    CREATE TABLE versions (id int PRIMARY KEY, note text);
    INSERT INTO versions VALUES (1, 'first'), (2, 'second'), (3, NULL);
    UPDATE versions SET note = 'changed' WHERE id = 2;
    CREATE TABLE words (word text, price numeric);
    INSERT INTO words VALUES ('pear', 1.50), ('apple', 2), ('fig', 0.25), ('Bob''s', 3);
    CREATE INDEX words_word_idx ON words (word);
    CREATE INDEX words_price_idx ON words (price);
    CREATE INDEX words_hash_idx ON words USING hash (word);
    CREATE TABLE empty (id int);
  `)
}, 120_000)
afterAll(() => db.close())

const orders = { schema: 'public', name: 'orders' }
const versions = { schema: 'public', name: 'versions' }
const words = { schema: 'public', name: 'words' }

/** Follows the first downlink from the root down to the leftmost leaf. */
async function leftmostLeaf(table: typeof orders, index: string): Promise<IndexPageView> {
  let page = await readIndexPage(db, table, index, null)
  while (!page.page.isLeaf) page = await readIndexPage(db, table, index, page.items[0].child)
  return page
}

describe('readTablePage', () => {
  it('shows every line pointer of the page, with the values Postgres prints for each row', async () => {
    const view = await readTablePage(db, orders, 3)
    expect(view.block).toBe(3)
    expect(view.columns).toEqual(['id', 'customer_id', 'order_date', 'status', 'total', 'shipping_address'])
    const lineCount = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM heap_page_items(get_raw_page('orders', 3))`,
    )
    expect(view.items).toHaveLength(lineCount.rows[0].count)
    expect(view.items.map((item) => item.offset)).toEqual(view.items.map((_, i) => i + 1))

    const expected = await db.query<string[]>(
      `SELECT id::text, customer_id::text, order_date::text, status, total::text, shipping_address
       FROM orders WHERE ctid >= '(3,0)' AND ctid < '(4,0)' ORDER BY ctid`,
      [],
      { rowMode: 'array' },
    )
    expect(view.items.map((item) => item.values)).toEqual(expected.rows)
  })

  it('marks row versions the session can’t see, and keeps NULLs', async () => {
    const view = await readTablePage(db, versions, 0)
    // id 2's first version was replaced by the UPDATE, which wrote a new one at the end.
    expect(view.items.map((item) => [item.offset, item.state, item.values])).toEqual([
      [1, 'normal', ['1', 'first']],
      [2, 'normal', null],
      [3, 'normal', ['3', null]],
      [4, 'normal', ['2', 'changed']],
    ])
  })

  it('carries each line pointer’s tuple header, the page header and the map bits, as pageinspect reads them', async () => {
    const view = await readTablePage(db, orders, 3)
    const real = await db.query<{
      lp: number
      lp_off: number
      lp_len: number
      t_xmin: string
      t_xmax: string
      t_infomask: number
      t_infomask2: number
      raw_flags: string[]
    }>(
      `SELECT h.lp, h.lp_off, h.lp_len, h.t_xmin::text, h.t_xmax::text, h.t_infomask, h.t_infomask2, f.raw_flags
       FROM heap_page_items(get_raw_page('orders', 3)) AS h, heap_tuple_infomask_flags(h.t_infomask, h.t_infomask2) AS f
       ORDER BY h.lp`,
    )
    expect(
      view.items.map((item) => [
        item.offset,
        item.tupleStart,
        item.length,
        item.header?.xmin,
        item.header?.xmax,
        item.header?.infomask,
        item.header?.infomask2,
        item.header?.flags,
      ]),
    ).toEqual(
      real.rows.map((row) => [row.lp, row.lp_off, row.lp_len, Number(row.t_xmin), Number(row.t_xmax), row.t_infomask, row.t_infomask2, row.raw_flags]),
    )
    expect(view.items[0].header?.ctid).toEqual({ block: 3, offset: 1 })
    const header = await db.query<{ lower: number; upper: number }>(`SELECT lower, upper FROM page_header(get_raw_page('orders', 3))`)
    expect(view.header).toEqual(header.rows[0])
    // The seed is vacuumed (and frozen: VACUUM freezes rows it can, PGlite having so few transactions).
    const frozen = await db.query<{ all_frozen: boolean }>(
      `SELECT bool_and(f.raw_flags @> ARRAY['HEAP_XMIN_COMMITTED', 'HEAP_XMIN_INVALID']) AS all_frozen
       FROM heap_page_items(get_raw_page('orders', 3)) AS h, heap_tuple_infomask_flags(h.t_infomask, h.t_infomask2) AS f`,
    )
    expect(view.visibility).toEqual({ allVisible: true, allFrozen: frozen.rows[0].all_frozen })
  })

  it('shows the old version an UPDATE replaced: its xmax, and its t_ctid pointing at the new version', async () => {
    const view = await readTablePage(db, versions, 0)
    const [old, , , replacement] = view.items
    expect(old.header?.xmax).toBe(0)
    const replaced = view.items[1]
    expect(replaced.header?.xmax).toBe(replacement.header?.xmin)
    expect(replaced.header?.ctid).toEqual({ block: 0, offset: 4 })
    expect(replacement.header?.flags).toContain('HEAP_UPDATED')
    // Never vacuumed, so the table has no visibility map yet.
    expect(view.visibility).toBeNull()
  })

  it('shows the last page when asked for one past the end, and nothing for a table with no pages', async () => {
    const [table] = await findRelations(db, [orders])
    expect((await readTablePage(db, orders, table.pages + 10)).block).toBe(table.pages - 1)
    const empty = await readTablePage(db, { schema: 'public', name: 'empty' }, 0)
    expect(empty).toMatchObject({ block: 0, columns: ['id'], items: [] })
  })

  it('says so when the table is gone', async () => {
    await expect(readTablePage(db, { schema: 'public', name: 'gone' }, 0)).rejects.toThrow('The table gone no longer exists.')
  })
})

describe('readIndexPage', () => {
  it('opens at the root, whose downlinks lead to the pages one level down', async () => {
    const root = await readIndexPage(db, orders, 'orders_pkey', null)
    const meta = await db.query<{ root: number; level: number }>(`SELECT root::int, level::int FROM bt_metap('orders_pkey')`)
    expect(root.page).toMatchObject({ block: meta.rows[0].root, isRoot: true, level: meta.rows[0].level, prev: null, next: null })
    expect(root.levels).toBe(meta.rows[0].level + 1)
    expect(root.keyColumns).toEqual(['id'])
    expect(root.unreadableKeys).toBeNull()
    // The first downlink stands for minus infinity; each other one keeps the lowest id of its child.
    expect(root.items[0]).toMatchObject({ role: 'downlink', key: [] })
    const second = root.items[1]
    expect(second.key).toHaveLength(1)
    const child = await readIndexPage(db, orders, 'orders_pkey', second.child)
    expect(child.page.level).toBe(root.page.level - 1)
    expect(child.page.prev).toBe(root.items[0].child)
    expect(child.items[0].key).toEqual(second.key)
  })

  it('shows a leaf’s keys as Postgres prints them, each with the rows it points at', async () => {
    const leaf = await leftmostLeaf(orders, 'orders_customer_id_order_date_idx')
    expect(leaf.keyColumns).toEqual(['customer_id', 'order_date'])
    expect(leaf.page).toMatchObject({ isLeaf: true, level: 0, prev: null })
    for (const entry of leaf.items.slice(0, 20)) {
      for (const row of entry.rows) {
        const found = await db.query<{ customer_id: string; order_date: string }>(
          `SELECT customer_id::text, order_date::text FROM orders WHERE ctid = '(${row.block},${row.offset})'`,
        )
        expect(entry.key).toEqual([found.rows[0].customer_id, found.rows[0].order_date])
      }
    }
  })

  // PGlite's databases sort text by byte (the C collation), so capitals come first.
  it('shows a page’s high key, printed by Postgres: the first key of the page to its right; none on the rightmost page', async () => {
    const root = await readIndexPage(db, orders, 'orders_pkey', null)
    expect(root.page.next).toBeNull()
    expect(root.highKey).toBeNull()
    const leaf = await leftmostLeaf(orders, 'orders_pkey')
    expect(leaf.page.next).not.toBeNull()
    const right = await readIndexPage(db, orders, 'orders_pkey', leaf.page.next)
    expect(leaf.highKey?.key).toEqual(right.items[0].key)
    // Every key on the page sorts at or below it.
    expect(Number(leaf.items.at(-1)?.key?.[0])).toBeLessThan(Number(leaf.highKey?.key?.[0]))
    const bytes = await db.query<{ data: string }>(`SELECT data FROM bt_page_items('orders_pkey', ${leaf.page.block}) WHERE itemoffset = 1`)
    expect(leaf.highKey?.keyBytes).toBe(bytes.rows[0].data)
  })

  it('prints text keys, and shows the bytes of keys it can’t read yet', async () => {
    const text = await readIndexPage(db, words, 'words_word_idx', null)
    expect(text.items.map((item) => item.key)).toEqual([["Bob's"], ['apple'], ['fig'], ['pear']])

    const numeric = await readIndexPage(db, words, 'words_price_idx', null)
    expect(numeric.unreadableKeys).toMatch(/numeric/)
    expect(numeric.items).toHaveLength(4)
    expect(numeric.items.every((item) => item.key === null && item.keyBytes !== '')).toBe(true)
  })

  it('goes to the root for a page that isn’t in the tree, and says so for an index it can’t browse', async () => {
    const root = await readIndexPage(db, orders, 'orders_pkey', null)
    expect((await readIndexPage(db, orders, 'orders_pkey', 0)).page.block).toBe(root.page.block)
    expect((await readIndexPage(db, orders, 'orders_pkey', 999_999)).page.block).toBe(root.page.block)
    await expect(readIndexPage(db, words, 'words_hash_idx', null)).rejects.toThrow('Only B-tree indexes')
    await expect(readIndexPage(db, words, 'gone_idx', null)).rejects.toThrow('The index gone_idx no longer exists.')
  })
})

describe('side effects', () => {
  it('leaves shared buffers as they were', async () => {
    const relations = await findRelations(db, [orders])
    await evictRelations(db, relations)
    await db.query(`SELECT * FROM orders WHERE id = 4242`)
    const before = await snapshotCache(db, relations)
    expect(before.pages.length).toBeGreaterThan(0)

    await readTablePage(db, orders, 10)
    await leftmostLeaf(orders, 'orders_pkey')
    expect(await snapshotCache(db, relations)).toEqual(before)
  })

  it('keeps the visitor’s transaction usable, and sees its own changes', async () => {
    await db.exec(`BEGIN; UPDATE versions SET note = 'in a transaction' WHERE id = 1`)
    try {
      const view = await readTablePage(db, versions, 0)
      expect(view.items.find((item) => item.values?.[0] === '1')?.values).toEqual(['1', 'in a transaction'])
      await expect(readIndexPage(db, words, 'words_hash_idx', null)).rejects.toThrow()
      const still = await db.query<{ note: string }>(`SELECT note FROM versions WHERE id = 1`)
      expect(still.rows[0].note).toBe('in a transaction')
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('keeps the visitor’s transaction usable when a read fails in Postgres', async () => {
    // pageinspect and pg_buffercache live in public, so with this search path Postgres can't find them.
    await db.exec(`BEGIN; SET LOCAL search_path = pg_catalog`)
    try {
      await expect(readTablePage(db, versions, 0)).rejects.toThrow(/does not exist/)
      const still = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM public.versions`)
      expect(still.rows[0].count).toBe(3)
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('says to roll back a failed transaction first', async () => {
    await db.exec('BEGIN')
    await expect(db.exec('SELECT 1 / 0')).rejects.toThrow()
    try {
      await expect(readTablePage(db, versions, 0)).rejects.toThrow('Run ROLLBACK first.')
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})
