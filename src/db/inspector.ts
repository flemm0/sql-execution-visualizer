import type { PGliteInterface } from '@electric-sql/pglite'
import type { TableName } from './plan'
import { query } from './query'

/*
 * The inspector: typed wrappers around pg_buffercache (which pages are in
 * shared buffers) and pageinspect (what is on a heap or B-tree page). The
 * replay engine reads real pages through these, so what the visualization
 * shows comes from Postgres.
 *
 * Each function sends one or two queries however many pages it's asked about:
 * every query through PGlite's worker proxy costs about a millisecond on top
 * of Postgres's own work (ADR 0022).
 */

/** A table or index, as Postgres names and stores it. */
export interface Relation {
  /** Postgres's id for the relation (pg_class.oid). Stays the same when its file is rewritten. */
  oid: number
  schema: string
  name: string
  kind: 'table' | 'index'
  /** How it's stored: "heap" for a table, "btree", "hash", "gin" and so on for an index. */
  accessMethod: string
  /** For an index, the oid of its table; null for a table. */
  tableOid: number | null
  /** The size of its main data, in pages (8 kB blocks). */
  pages: number
}

/**
 * Each of a relation's files is a "fork": its data (main), its free space map
 * (fsm), its visibility map (vm), and for unlogged relations an empty copy to
 * restore after a crash (init). Page numbers count from 0 in each fork.
 */
export type Fork = 'main' | 'fsm' | 'vm' | 'init'

const FORKS: Fork[] = ['main', 'fsm', 'vm', 'init']

/** One page of a relation that is in a shared buffer. */
export interface CachedPage {
  relationOid: number
  fork: Fork
  /** The page number within the fork. */
  block: number
  /** Which buffer holds it (pg_buffercache's bufferid), to evict it. */
  bufferId: number
}

/** Which pages of some relations are in shared buffers at one moment. */
export interface CacheSnapshot {
  pages: CachedPage[]
}

/** A heap row's location: page number and line pointer number, as in a ctid "(12,3)". */
export interface Tid {
  block: number
  offset: number
}

/** One heap page, as heap_page_items shows it. */
export interface HeapPage {
  block: number
  items: HeapItem[]
}

/**
 * One line pointer of a heap page, and the row version (tuple) it points to.
 * Tuple fields are null when the line pointer doesn't point at a tuple.
 */
export interface HeapItem {
  /** The line pointer's number: the second part of the row's ctid. */
  offset: number
  /**
   * normal: points at a tuple. unused: free. dead: its tuple was removed, but an
   * index may still point here. redirect: a HOT chain starts at another line pointer.
   */
  state: 'unused' | 'normal' | 'redirect' | 'dead'
  /** For a redirect, the line pointer it redirects to. */
  redirectTo: number | null
  /** The tuple's length in bytes. */
  length: number
  /** The transaction that created this version of the row. */
  xmin: number | null
  /** The transaction that deleted or updated it; 0 if none did. */
  xmax: number | null
  /** The row's own location, or after an UPDATE, the location of its newer version. */
  ctid: Tid | null
  /** Status bits, e.g. whether xmin is known to have committed (see htup_details.h). */
  infomask: number | null
  infomask2: number | null
}

/** The B-tree metapage (always page 0): where the tree starts. */
export interface BtreeMeta {
  /** The root page, and its level: leaves are level 0, so this is the tree's height minus one. */
  root: number
  level: number
  /**
   * Where searches start. Usually the root; after many deletions it can be a
   * lower page, when the levels above it have a single page each.
   */
  fastRoot: number
  fastLevel: number
}

/** One B-tree page, as bt_page_stats and bt_page_items show it. */
export interface BtreePage {
  block: number
  /** 0 for a leaf; one more for each level above. */
  level: number
  isLeaf: boolean
  isRoot: boolean
  /** Deleted, or half-dead while being deleted: searches skip it. */
  isIgnored: boolean
  /** The pages to the left and right on the same level, or null at either end. */
  prev: number | null
  next: number | null
  items: BtreeItem[]
}

/**
 * One B-tree item.
 * - highKey: the upper bound of keys on this page. Every page but the rightmost on its level has one, at offset 1.
 * - downlink (internal pages): points to a child page holding keys from this key up to the next item's key.
 *   The first downlink has no key: it stands for "minus infinity".
 * - entry (leaf pages): a key and the heap rows that have it.
 */
export interface BtreeItem {
  offset: number
  role: 'highKey' | 'downlink' | 'entry'
  /**
   * The key's bytes in hex, as bt_page_items shows them, e.g. "6f 01 00 00 00 00 00 00"
   * (367 as a 4-byte integer, padded to 8 bytes). Empty for "minus infinity".
   */
  keyBytes: string
  /** For a downlink, the child page. */
  childBlock: number | null
  /**
   * For an entry, the heap rows it points at: usually one; several for a
   * posting list, where B-tree deduplication stores one key for many rows.
   */
  heapTids: Tid[]
  /** Marked dead: the rows it points at are gone, so scans skip it. */
  dead: boolean
}

/**
 * Finds the given tables and all their indexes: the relations whose pages a
 * query on those tables can read. Tables Postgres keeps outside shared buffers
 * (temporary tables) or that have no storage of their own (partitioned tables,
 * foreign tables) are left out, as are names that don't exist.
 */
export async function findRelations(db: PGliteInterface, tables: TableName[]): Promise<Relation[]> {
  if (tables.length === 0) return []
  const names = tables.map((table) => `(${literal(table.schema)}, ${literal(table.name)})`).join(', ')
  const result = await query<{
    oid: number
    schema: string
    name: string
    kind: 'table' | 'index'
    access_method: string
    table_oid: number | null
    pages: number
  }>(db, `
    WITH tables AS (
      SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname, c.relname) IN (${names}) AND c.relkind IN ('r', 'm') AND c.relpersistence <> 't'
    )
    SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name,
      CASE WHEN c.relkind = 'i' THEN 'index' ELSE 'table' END AS kind,
      am.amname AS access_method, i.indrelid::int AS table_oid,
      (pg_relation_size(c.oid) / current_setting('block_size')::int)::int AS pages
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am ON am.oid = c.relam
    LEFT JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.oid IN (SELECT oid FROM tables) OR (c.relkind = 'i' AND i.indrelid IN (SELECT oid FROM tables))
    ORDER BY coalesce(i.indrelid, c.oid), c.relkind DESC, c.relname
  `)
  return result.rows.map((row) => ({
    oid: row.oid,
    schema: row.schema,
    name: row.name,
    kind: row.kind,
    accessMethod: row.access_method,
    tableOid: row.table_oid,
    pages: row.pages,
  }))
}

/**
 * Removes every page of these relations from shared buffers, so the next query
 * has to read them from disk ("Start with an empty cache"). Returns how many
 * buffers were emptied.
 */
export async function evictRelations(db: PGliteInterface, relations: Relation[]): Promise<number> {
  if (relations.length === 0) return 0
  const result = await query<{ evicted: number }>(db, `
    SELECT coalesce(sum(e.buffers_evicted), 0)::int AS evicted
    FROM unnest(${oidArray(relations)}) AS r(oid), pg_buffercache_evict_relation(r.oid::regclass) AS e
  `)
  return result.rows[0].evicted
}

/** Which pages of these relations are in shared buffers right now, in every fork. */
export async function snapshotCache(db: PGliteInterface, relations: Relation[]): Promise<CacheSnapshot> {
  if (relations.length === 0) return { pages: [] }
  // pg_buffercache knows pages by file (relfilenode), not by relation: a
  // relation gets a new file when it's rewritten, e.g. by TRUNCATE.
  const result = await query<{ relation: number; fork: number; block: number; buffer: number }>(db, `
    SELECT r.oid::int AS relation, b.relforknumber::int AS fork, b.relblocknumber::int8 AS block, b.bufferid AS buffer
    FROM unnest(${oidArray(relations)}) AS r(oid)
    JOIN pg_buffercache b ON b.relfilenode = pg_relation_filenode(r.oid)
    WHERE b.reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
    ORDER BY 1, 2, 3
  `)
  return {
    pages: result.rows.map((row) => ({
      relationOid: row.relation,
      fork: FORKS[row.fork],
      block: Number(row.block),
      bufferId: row.buffer,
    })),
  }
}

/** The page numbers of a relation's main data that are in the snapshot. */
export function cachedBlocks(snapshot: CacheSnapshot, relation: Relation): Set<number> {
  const blocks = new Set<number>()
  for (const page of snapshot.pages) {
    if (page.relationOid === relation.oid && page.fork === 'main') blocks.add(page.block)
  }
  return blocks
}

/**
 * Puts these relations' part of the cache back as it was in the snapshot, by
 * evicting every page that has been loaded since. Reading pages with
 * pageinspect loads them into shared buffers, like any other read; this undoes
 * that, so the next query finds the cache as the visitor's own query left it.
 * Returns how many pages were evicted.
 *
 * Pages evicted since the snapshot stay evicted: nothing the app does evicts
 * a page between the snapshot and this call.
 */
export async function restoreCache(
  db: PGliteInterface,
  relations: Relation[],
  snapshot: CacheSnapshot,
): Promise<number> {
  const keep = new Set(snapshot.pages.map(pageKey))
  const now = await snapshotCache(db, relations)
  const added = now.pages.filter((page) => !keep.has(pageKey(page)))
  if (added.length === 0) return 0
  const result = await query<{ evicted: number }>(db, `
    SELECT count(*) FILTER (WHERE e.buffer_evicted)::int AS evicted
    FROM unnest(ARRAY[${added.map((page) => page.bufferId).join(', ')}]::int[]) AS b(id), pg_buffercache_evict(b.id) AS e
  `)
  return result.rows[0].evicted
}

/** Reads heap pages of a table with heap_page_items, in the order asked (a page asked for twice is read once). */
export async function readHeapPages(db: PGliteInterface, table: Relation, blocks: number[]): Promise<HeapPage[]> {
  if (blocks.length === 0) return []
  const result = await query<{
    block: number
    lp: number
    lp_flags: number
    lp_off: number
    lp_len: number
    t_xmin: string | null
    t_xmax: string | null
    t_ctid: string | null
    t_infomask: number | null
    t_infomask2: number | null
  }>(db, `
    SELECT p.block::int AS block, h.lp, h.lp_flags, h.lp_off, h.lp_len,
      h.t_xmin::text, h.t_xmax::text, h.t_ctid::text, h.t_infomask, h.t_infomask2
    FROM unnest(${intArray(unique(blocks))}) AS p(block),
      heap_page_items(get_raw_page(${relationName(table)}, p.block)) AS h
    ORDER BY p.block, h.lp
  `)
  const pages = new Map<number, HeapPage>(blocks.map((block) => [block, { block, items: [] }]))
  for (const row of result.rows) {
    const state = LINE_POINTER_STATES[row.lp_flags]
    pages.get(row.block)?.items.push({
      offset: row.lp,
      state,
      // For a redirect, lp_off holds the line pointer it redirects to.
      redirectTo: state === 'redirect' ? row.lp_off : null,
      length: row.lp_len,
      xmin: row.t_xmin === null ? null : Number(row.t_xmin),
      xmax: row.t_xmax === null ? null : Number(row.t_xmax),
      ctid: row.t_ctid === null ? null : parseTid(row.t_ctid),
      infomask: row.t_infomask,
      infomask2: row.t_infomask2,
    })
  }
  return blocks.map((block) => pages.get(block) as HeapPage)
}

const LINE_POINTER_STATES: HeapItem['state'][] = ['unused', 'normal', 'redirect', 'dead']

/** Reads a B-tree index's metapage with bt_metap. */
export async function readBtreeMeta(db: PGliteInterface, index: Relation): Promise<BtreeMeta> {
  const result = await query<{ root: number; level: number; fastroot: number; fastlevel: number }>(
    db,
    `SELECT root::int8, level::int8, fastroot::int8, fastlevel::int8 FROM bt_metap(${relationName(index)})`,
  )
  const meta = result.rows[0]
  return {
    root: Number(meta.root),
    level: Number(meta.level),
    fastRoot: Number(meta.fastroot),
    fastLevel: Number(meta.fastlevel),
  }
}

// Bits of a B-tree page's btpo_flags (nbtree.h).
const BTP_LEAF = 1
const BTP_ROOT = 2
const BTP_DELETED = 4
const BTP_HALF_DEAD = 16

/** Reads B-tree pages with bt_page_stats and bt_page_items, in the order asked (a page asked for twice is read once). */
export async function readBtreePages(db: PGliteInterface, index: Relation, blocks: number[]): Promise<BtreePage[]> {
  if (blocks.length === 0) return []
  const name = relationName(index)
  const stats = await query<{ block: number; level: number; flags: number; prev: number; next: number }>(db, `
    SELECT p.block::int AS block, s.btpo_level::int AS level, s.btpo_flags AS flags,
      s.btpo_prev::int8 AS prev, s.btpo_next::int8 AS next
    FROM unnest(${intArray(unique(blocks))}) AS p(block), bt_page_stats(${name}, p.block) AS s
  `)
  const items = await query<{
    block: number
    itemoffset: number
    ctid: string
    data: string
    dead: boolean | null
    heap_tids: (string | null)[]
  }>(db, `
    SELECT p.block::int AS block, i.itemoffset, i.ctid::text, i.data, i.dead,
      -- A posting list has its rows in tids; a plain entry has its one row in htid.
      -- As json, since query() decodes json but not arrays.
      to_json(coalesce(i.tids, ARRAY[i.htid])::text[]) AS heap_tids
    FROM unnest(${intArray(unique(blocks))}) AS p(block), bt_page_items(${name}, p.block) AS i
    ORDER BY p.block, i.itemoffset
  `)

  const pages = new Map<number, BtreePage>()
  for (const row of stats.rows) {
    // In bt_page_stats, 0 means "no page": page 0 is the metapage, never a neighbor.
    const prev = Number(row.prev)
    const next = Number(row.next)
    pages.set(row.block, {
      block: row.block,
      level: row.level,
      isLeaf: (row.flags & BTP_LEAF) !== 0,
      isRoot: (row.flags & BTP_ROOT) !== 0,
      isIgnored: (row.flags & (BTP_DELETED | BTP_HALF_DEAD)) !== 0,
      prev: prev === 0 ? null : prev,
      next: next === 0 ? null : next,
      items: [],
    })
  }
  for (const row of items.rows) {
    const page = pages.get(row.block) as BtreePage
    // Every page but the rightmost on its level starts with its high key.
    const role = row.itemoffset === 1 && page.next !== null ? 'highKey' : page.isLeaf ? 'entry' : 'downlink'
    page.items.push({
      offset: row.itemoffset,
      role,
      keyBytes: row.data,
      // A downlink keeps its child's page number where an entry keeps a heap row's.
      childBlock: role === 'downlink' ? parseTid(row.ctid).block : null,
      heapTids: role === 'entry' ? row.heap_tids.flatMap((tid) => (tid === null ? [] : [parseTid(tid)])) : [],
      dead: row.dead === true,
    })
  }
  return blocks.map((block) => pages.get(block) as BtreePage)
}

/** Reads a tid as Postgres writes it, "(12,3)". */
export function parseTid(text: string): Tid {
  const match = /^\((\d+),(\d+)\)$/.exec(text)
  if (match === null) throw new Error(`Not a tid: ${text}`)
  return { block: Number(match[1]), offset: Number(match[2]) }
}

function pageKey(page: CachedPage) {
  return `${page.relationOid}/${page.fork}/${page.block}`
}

/** A relation's name as a SQL string, for pageinspect's functions, which take a name rather than an oid. */
function relationName(relation: Relation) {
  // regclass prints the name the way Postgres would quote and qualify it.
  return `${relation.oid}::regclass::text`
}

function oidArray(relations: Relation[]) {
  return `ARRAY[${relations.map((relation) => relation.oid).join(', ')}]::oid[]`
}

/** The numbers without repeats, in the order first seen. */
function unique(numbers: number[]) {
  return [...new Set(numbers)]
}

function intArray(numbers: number[]) {
  return `ARRAY[${numbers.join(', ')}]::int8[]`
}

/** A string as a SQL string literal. */
function literal(text: string) {
  return `'${text.replaceAll("'", "''")}'`
}
