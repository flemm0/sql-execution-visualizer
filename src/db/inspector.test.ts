import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import {
  cachedBlocks,
  evictRelations,
  findRelations,
  parseTid,
  readBtreeMeta,
  readBtreePages,
  readHeapPages,
  readIndexColumns,
  restoreCache,
  snapshotCache,
  type Relation,
} from './inspector'
import { seedDatabase } from './seed'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
  // Tables of the tests' own, so the seed tables stay as generated.
  await db.exec(`
    CREATE SCHEMA "Odd Schema";
    CREATE TABLE "Odd Schema"."Bob's Table" (id int PRIMARY KEY);
    INSERT INTO "Odd Schema"."Bob's Table" SELECT generate_series(1, 10);
    CREATE TABLE versions (id int PRIMARY KEY, note text);
    INSERT INTO versions VALUES (1, 'first'), (2, 'second');
    UPDATE versions SET note = 'changed' WHERE id = 2;
    CREATE TABLE repeats AS SELECT 7 AS value, n FROM generate_series(1, 50) AS n;
    CREATE INDEX repeats_value_idx ON repeats (value);
    CREATE TEMP TABLE scratch (id int);
  `)
}, 120_000)
afterAll(() => db.close())

/** The table or index with this name, found through its table. */
async function relation(name: string): Promise<Relation> {
  const table = await db.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, t.relname AS name
     FROM pg_class c
     LEFT JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_class t ON t.oid = coalesce(i.indrelid, c.oid)
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.relname = $1`,
    [name],
  )
  const found = (await findRelations(db, table.rows)).find((candidate) => candidate.name === name)
  if (!found) throw new Error(`No relation ${name}`)
  return found
}

/** The ctid of each row a query returns, e.g. "(12,3)". */
async function ctids(sql: string) {
  const result = await db.query<{ ctid: string }>(sql)
  return result.rows.map((row) => row.ctid)
}

describe('findRelations', () => {
  it('finds a table and all its indexes, with their sizes in pages', async () => {
    const relations = await findRelations(db, [{ schema: 'public', name: 'orders' }])
    expect(relations.map((found) => [found.name, found.kind, found.accessMethod])).toEqual([
      ['orders', 'table', 'heap'],
      ['orders_customer_id_order_date_idx', 'index', 'btree'],
      ['orders_pkey', 'index', 'btree'],
    ])
    const orders = relations[0]
    expect(relations.slice(1).every((index) => index.tableOid === orders.oid)).toBe(true)
    expect(orders.tableOid).toBeNull()
    // The seed is VACUUM ANALYZEd, so pg_class's page counts are up to date.
    const sizes = await db.query<{ relname: string; relpages: number }>(
      `SELECT relname, relpages FROM pg_class WHERE relname IN ('orders', 'orders_pkey')`,
    )
    for (const { relname, relpages } of sizes.rows) {
      expect(relations.find((found) => found.name === relname)?.pages).toBe(relpages)
    }
  })

  it('handles names that need quoting', async () => {
    const relations = await findRelations(db, [{ schema: 'Odd Schema', name: "Bob's Table" }])
    expect(relations.map((found) => found.name)).toEqual(["Bob's Table", "Bob's Table_pkey"])
  })

  it('leaves out temporary tables, which aren’t kept in shared buffers, and names that don’t exist', async () => {
    const temp = await db.query<{ schema: string }>(`SELECT nspname AS schema FROM pg_namespace WHERE oid = pg_my_temp_schema()`)
    const relations = await findRelations(db, [
      { schema: temp.rows[0].schema, name: 'scratch' },
      { schema: 'public', name: 'no_such_table' },
      { schema: 'public', name: 'categories' },
    ])
    expect(relations.map((found) => found.name)).toEqual(['categories', 'categories_pkey'])
  })
})

describe('the cache', () => {
  it('snapshots the cached pages of each relation, and evicts them', async () => {
    const relations = await findRelations(db, [{ schema: 'public', name: 'orders' }])
    const [orders, , pkey] = relations
    await evictRelations(db, relations)
    expect((await snapshotCache(db, relations)).pages).toEqual([])

    await db.query('SELECT * FROM orders WHERE id = 4242')
    const snapshot = await snapshotCache(db, relations)
    const [heapTid] = await ctids('SELECT ctid FROM orders WHERE id = 4242')
    expect(cachedBlocks(snapshot, orders)).toEqual(new Set([parseTid(heapTid).block]))
    // The root and one leaf. The metapage stays out: Postgres keeps a copy of it in memory.
    const meta = await readBtreeMeta(db, pkey)
    expect(cachedBlocks(snapshot, pkey).has(meta.root)).toBe(true)

    // pg_buffercache agrees, buffer by buffer.
    for (const page of snapshot.pages) {
      const buffer = await db.query<{ block: number }>(
        `SELECT relblocknumber AS block FROM pg_buffercache WHERE bufferid = $1 AND relfilenode = pg_relation_filenode($2)`,
        [page.bufferId, page.relationOid],
      )
      expect(buffer.rows).toEqual([{ block: page.block }])
    }

    expect(await evictRelations(db, relations)).toBe(snapshot.pages.length)
    expect((await snapshotCache(db, relations)).pages).toEqual([])
  })

  it('tells the forks apart: an Index Only Scan reads the visibility map', async () => {
    const relations = await findRelations(db, [{ schema: 'public', name: 'orders' }])
    await evictRelations(db, relations)
    await db.query('SELECT id FROM orders WHERE id = 4242')
    const orders = relations[0]
    const forks = (await snapshotCache(db, relations)).pages
      .filter((page) => page.relationOid === orders.oid)
      .map((page) => page.fork)
    expect(forks).toEqual(['vm'])
    expect(cachedBlocks(await snapshotCache(db, relations), orders)).toEqual(new Set())
  })

  it('restores a snapshot by evicting what pageinspect loaded since', async () => {
    const relations = await findRelations(db, [{ schema: 'public', name: 'orders' }])
    const [orders, , pkey] = relations
    await evictRelations(db, relations)
    await db.query('SELECT * FROM orders WHERE id = 4242')
    const before = await snapshotCache(db, relations)

    await readHeapPages(db, orders, [0, 1, 2])
    await readBtreePages(db, pkey, [1, 2])
    const polluted = await snapshotCache(db, relations)
    expect(polluted.pages.length).toBeGreaterThan(before.pages.length)

    expect(await restoreCache(db, relations, before)).toBe(polluted.pages.length - before.pages.length)
    expect(await snapshotCache(db, relations)).toEqual(before)
    expect(await restoreCache(db, relations, before)).toBe(0)
  })
})

describe('readHeapPages', () => {
  it('reads each line pointer and tuple header of the pages asked, in that order', async () => {
    const orders = await relation('orders')
    const [tid] = await ctids('SELECT ctid FROM orders WHERE id = 4242')
    const { block, offset } = parseTid(tid)
    const pages = await readHeapPages(db, orders, [block + 1, block])
    expect(pages.map((page) => page.block)).toEqual([block + 1, block])

    const onPage = await ctids(`SELECT ctid FROM orders WHERE ctid >= '(${block},0)' AND ctid < '(${block + 1},0)'`)
    expect(pages[1].items).toHaveLength(onPage.length)
    const item = pages[1].items.find((candidate) => candidate.offset === offset)
    const xmin = await db.query<{ xmin: string }>('SELECT xmin::text FROM orders WHERE id = 4242')
    expect(item).toMatchObject({ state: 'normal', ctid: { block, offset }, xmin: Number(xmin.rows[0].xmin), xmax: 0 })
  })

  it('shows an updated row’s old version pointing at its new one', async () => {
    const versions = await relation('versions')
    const [page] = await readHeapPages(db, versions, [0])
    expect(page.items.map((item) => item.offset)).toEqual([1, 2, 3])
    const [first, old, updated] = page.items
    expect(first.ctid).toEqual({ block: 0, offset: 1 })
    expect(old.xmax).toBe(updated.xmin)
    expect(old.ctid).toEqual({ block: 0, offset: 3 })
    expect(await ctids('SELECT ctid FROM versions WHERE id = 2')).toEqual(['(0,3)'])
  })
})

describe('B-tree pages', () => {
  it('reads the metapage', async () => {
    const pkey = await relation('orders_pkey')
    const meta = await readBtreeMeta(db, pkey)
    expect(meta).toEqual({ root: meta.root, level: 1, fastRoot: meta.root, fastLevel: 1 })
    const stats = await db.query<{ type: string }>(`SELECT type FROM bt_page_stats('orders_pkey', ${meta.root})`)
    expect(stats.rows[0].type).toBe('r')
  })

  it('follows downlinks from the root to the leaves, which link left to right', async () => {
    const pkey = await relation('orders_pkey')
    const meta = await readBtreeMeta(db, pkey)
    const [root] = await readBtreePages(db, pkey, [meta.root])
    expect(root).toMatchObject({ isRoot: true, isLeaf: false, level: 1, prev: null, next: null })
    // The root is the rightmost page of its level, so it has no high key.
    expect(root.items.every((item) => item.role === 'downlink')).toBe(true)
    expect(root.items[0].keyBytes).toBe('') // "minus infinity"
    expect(root.items[1].keyBytes).not.toBe('')

    const children = root.items.map((item) => item.childBlock as number)
    expect(children).toHaveLength(pkey.pages - 2) // every page but the metapage and the root
    const leaves = await readBtreePages(db, pkey, children)
    leaves.forEach((leaf, i) => {
      expect(leaf).toMatchObject({ isLeaf: true, isRoot: false, level: 0 })
      expect(leaf.prev).toBe(i === 0 ? null : children[i - 1])
      expect(leaf.next).toBe(i === children.length - 1 ? null : children[i + 1])
      // A high key first on every leaf but the rightmost, then entries.
      expect(leaf.items[0].role).toBe(leaf.next === null ? 'entry' : 'highKey')
      expect(leaf.items.slice(1).every((item) => item.role === 'entry')).toBe(true)
    })

    // Exactly one leaf has the entry for id 4242, pointing at its heap row.
    const [tid] = await ctids('SELECT ctid FROM orders WHERE id = 4242')
    const holding = leaves.filter((leaf) =>
      leaf.items.some((item) => item.heapTids.some((heap) => `(${heap.block},${heap.offset})` === tid)),
    )
    expect(holding).toHaveLength(1)
    // Every row is in the index exactly once.
    const entries = leaves.flatMap((leaf) => leaf.items.filter((item) => item.role === 'entry'))
    expect(entries.reduce((sum, item) => sum + item.heapTids.length, 0)).toBe(50_000)
  })

  it('reads a one-page index, whose root is its only leaf', async () => {
    const pkey = await relation('categories_pkey')
    const meta = await readBtreeMeta(db, pkey)
    expect(meta.level).toBe(0)
    const [root] = await readBtreePages(db, pkey, [meta.root])
    expect(root).toMatchObject({ isRoot: true, isLeaf: true, prev: null, next: null })
    expect(root.items.map((item) => item.role)).toEqual(Array(12).fill('entry'))
  })

  it('reads a posting list: one key for many rows', async () => {
    const index = await relation('repeats_value_idx')
    const meta = await readBtreeMeta(db, index)
    const [root] = await readBtreePages(db, index, [meta.root])
    const entries = root.items.filter((item) => item.role === 'entry')
    expect(entries.some((item) => item.heapTids.length > 1)).toBe(true)
    const pointedAt = entries.flatMap((item) => item.heapTids.map((heap) => `(${heap.block},${heap.offset})`))
    expect(pointedAt.sort()).toEqual((await ctids('SELECT ctid FROM repeats')).sort())
  })
})

describe('pivot keys: high keys and downlinks', () => {
  it('keep only the key columns needed to tell pages apart, and a heap row when one key spans pages', async () => {
    await db.exec(`
      CREATE TABLE pivots (a int, b int, c int);
      INSERT INTO pivots SELECT n, n % 10, 7 FROM generate_series(1, 3000) AS n;
      CREATE INDEX pivots_a_b_idx ON pivots (a, b);
      CREATE INDEX pivots_c_idx ON pivots (c) WITH (deduplicate_items = off);
    `)
    const ab = await relation('pivots_a_b_idx')
    const [abRoot] = await readBtreePages(db, ab, [(await readBtreeMeta(db, ab)).root])
    const [minusInfinity, ...downlinks] = abRoot.items
    expect(minusInfinity).toMatchObject({ keyColumns: 0, keyBytes: '', hasHeapTid: false })
    // Values of a are unique, so a is enough to tell two leaves apart: b is dropped.
    expect(downlinks.every((item) => item.keyColumns === 1 && !item.hasHeapTid)).toBe(true)

    // Every entry of pivots_c_idx has c = 7, so only the heap row tells pages apart.
    const c = await relation('pivots_c_idx')
    const [cRoot] = await readBtreePages(db, c, [(await readBtreeMeta(db, c)).root])
    expect(cRoot.items.slice(1).every((item) => item.keyColumns === 1 && item.hasHeapTid)).toBe(true)
    const [leaf] = await readBtreePages(db, c, [cRoot.items[1].childBlock as number])
    expect(leaf.items[0]).toMatchObject({ role: 'highKey', keyColumns: 1, hasHeapTid: true })
    expect(leaf.items[1]).toMatchObject({ role: 'entry', keyColumns: null, hasHeapTid: false, hasNulls: false })
  })

  it('say when an entry’s key has NULLs', async () => {
    await db.exec(`
      CREATE TABLE maybe (v int);
      INSERT INTO maybe VALUES (1), (NULL);
      CREATE INDEX maybe_v_idx ON maybe (v);
    `)
    const index = await relation('maybe_v_idx')
    const [root] = await readBtreePages(db, index, [(await readBtreeMeta(db, index)).root])
    expect(root.items.map((item) => [item.hasNulls, item.keyBytes])).toEqual([
      [false, '01 00 00 00 00 00 00 00'],
      [true, ''],
    ])
  })
})

describe('readIndexColumns', () => {
  it('reads each column’s table column, type, collation and order, then the INCLUDE columns', async () => {
    await db.exec(`
      CREATE TABLE people (id int, name text, email text, born date);
      CREATE INDEX people_idx ON people (name COLLATE "C" DESC, lower(email) text_pattern_ops, born NULLS FIRST) INCLUDE (id);
    `)
    expect(await readIndexColumns(db, await relation('people_idx'))).toEqual([
      { name: 'name', type: 'text', isKey: true, collation: '"C"', descending: true, nullsFirst: true, defaultOrder: true },
      { name: null, type: 'text', isKey: true, collation: '"default"', descending: false, nullsFirst: false, defaultOrder: false },
      { name: 'born', type: 'date', isKey: true, collation: null, descending: false, nullsFirst: true, defaultOrder: true },
      { name: 'id', type: 'int4', isKey: false, collation: null, descending: false, nullsFirst: false, defaultOrder: true },
    ])
    expect(await readIndexColumns(db, await relation('orders_pkey'))).toEqual([
      { name: 'id', type: 'int4', isKey: true, collation: null, descending: false, nullsFirst: false, defaultOrder: true },
    ])
  })
})

describe('parseTid', () => {
  it('reads a ctid', () => {
    expect(parseTid('(12,3)')).toEqual({ block: 12, offset: 3 })
    expect(() => parseTid('12,3')).toThrow('Not a tid')
  })
})
