import type { PGliteInterface } from '@electric-sql/pglite'
import { canReadKeys, readKey } from '../replay/indexKeys'
import {
  findRelations,
  readBtreeMeta,
  readBtreePages,
  readHeapPages,
  readIndexColumns,
  restoreCache,
  snapshotCache,
  type BtreePage,
  type CacheSnapshot,
  type HeapItem,
  type Relation,
  type Tid,
} from './inspector'
import type { TableName } from './plan'
import { query } from './query'
import { transactionStatus } from './runner'
import { quoteIdentifier } from './sql'

/*
 * The page browser: reads one page of a table or index for the visualization
 * pane, when a visitor opens it from the schema browser (ADR 0032). Like the
 * replay, it reads through pageinspect, and Postgres writes every value shown.
 *
 * Reading a page loads it into shared buffers, so afterwards every page that
 * wasn't cached before is evicted again: browsing never changes the hits and
 * reads the next query sees. Inside a transaction block the reads run in a
 * savepoint, so a failed read can't abort the visitor's transaction.
 */

/** One page of a table: each line pointer, with the row's values when the visitor's session can see it. */
export interface TablePageView {
  kind: 'table'
  table: Relation
  /** The page shown: the one asked for, or the last page if the table has shrunk below it. */
  block: number
  /** The table's columns, in order. */
  columns: string[]
  items: TablePageItem[]
}

export interface TablePageItem {
  /** The line pointer's number: the second part of the row's ctid. */
  offset: number
  state: HeapItem['state']
  /** For a redirect, the line pointer it redirects to. */
  redirectTo: number | null
  /**
   * The row's values as Postgres writes them (null for NULL), one per column;
   * null when the visitor's session can't see this row version (deleted,
   * replaced by an UPDATE, or not committed yet) or there is no row here.
   */
  values: (string | null)[] | null
}

/** One page of a B-tree index, with its keys as Postgres writes them. */
export interface IndexPageView {
  kind: 'index'
  index: Relation
  table: Relation
  /** The tree's levels, the leaf level included. */
  levels: number
  /** The index's key columns: a table column's name, or "expression". */
  keyColumns: string[]
  page: Omit<BtreePage, 'items'>
  /** Why the keys can't be read, if they can't (the items then carry their bytes); null when they can. */
  unreadableKeys: string | null
  /** The page's downlinks or entries, in order (the high key apart). */
  items: IndexPageItem[]
}

export interface IndexPageItem {
  offset: number
  role: 'downlink' | 'entry'
  /**
   * Its key, one value per key column, as Postgres writes them (null for
   * NULL). A downlink can keep fewer columns than the index has (the ones it
   * drops count as minus infinity), and a page's first downlink keeps none.
   * Null when the keys can't be read.
   */
  key: (string | null)[] | null
  /** The key's bytes in hex, as bt_page_items shows them. */
  keyBytes: string
  /** For a downlink, the child page. */
  child: number | null
  /** For an entry, the heap rows it points at (several for a posting list). */
  rows: Tid[]
  /** Marked dead: scans skip it. */
  dead: boolean
}

/** Reads a page of a table. Throws an Error whose message says what went wrong, e.g. that the table is gone. */
export async function readTablePage(db: PGliteInterface, table: TableName, block: number): Promise<TablePageView> {
  return withoutSideEffects(db, table, async (relations) => {
    const heap = relations[0]
    const columns = await columnsOf(db, heap)
    if (heap.pages === 0) return { kind: 'table', table: heap, block: 0, columns, items: [] }
    const shown = Math.min(Math.max(0, block), heap.pages - 1)
    // The rows the session can see, read first: reading them can prune the
    // page (remove row versions no one can see), so the line pointers read
    // next show the page as it is now. A TID range scan reads this page only.
    const values = columns.map((column) => `t.${quoteIdentifier(column)}::text`).join(', ')
    const visible = await query<{ offset: number; values: (string | null)[] }>(db, `
      SELECT (ctid::text::point)[1]::int AS offset, to_json(ARRAY[${values}]::text[]) AS values
      FROM ONLY ${quoteIdentifier(heap.schema)}.${quoteIdentifier(heap.name)} AS t
      WHERE ctid >= '(${shown},0)'::tid AND ctid < '(${shown + 1},0)'::tid
    `)
    const rows = new Map(visible.rows.map((row) => [row.offset, row.values]))
    const [page] = await readHeapPages(db, heap, [shown])
    return {
      kind: 'table',
      table: heap,
      block: shown,
      columns,
      items: page.items.map((item) => ({
        offset: item.offset,
        state: item.state,
        redirectTo: item.redirectTo,
        values: rows.get(item.offset) ?? null,
      })),
    }
  })
}

/**
 * Reads a page of a B-tree index; with `block` null (or not a page of the
 * tree, e.g. after REINDEX shrank it), its root. Throws an Error whose message
 * says what went wrong, e.g. that the index is gone or isn't a B-tree.
 */
export async function readIndexPage(
  db: PGliteInterface,
  table: TableName,
  indexName: string,
  block: number | null,
): Promise<IndexPageView> {
  return withoutSideEffects(db, table, async (relations) => {
    const index = relations.find((relation) => relation.kind === 'index' && relation.name === indexName)
    if (index === undefined) throw new Error(`The index ${indexName} no longer exists.`)
    if (index.accessMethod !== 'btree') {
      throw new Error(`Only B-tree indexes can be browsed so far; ${indexName} is a ${index.accessMethod} index.`)
    }
    const meta = await readBtreeMeta(db, index)
    // Page 0 is the metapage, not part of the tree.
    const shown = block === null || block < 1 || block >= index.pages ? meta.root : block
    const [page] = await readBtreePages(db, index, [shown])
    const columns = (await readIndexColumns(db, index)).filter((column) => column.isKey)
    const items = page.items.filter((item) => item.role !== 'highKey')

    const unreadable = columns.find((column) => !canReadKeys(column.type))
    let unreadableKeys = unreadable ? `Keys of type ${unreadable.type} can’t be read yet, so their bytes are shown.` : null
    let keys: ((string | null)[] | null)[] = items.map(() => null)
    if (unreadableKeys === null) {
      try {
        keys = await printKeys(
          db,
          columns.map((column) => column.type),
          items.map((item) => readKey(item.keyBytes, item.hasNulls, columns, item.keyColumns ?? columns.length)),
        )
      } catch (error) {
        // readKey can't read every key yet (e.g. NULL in some columns only).
        unreadableKeys = `${error instanceof Error ? error.message : String(error)} Their bytes are shown.`
      }
    }

    return {
      kind: 'index',
      index,
      table: relations[0],
      levels: meta.level + 1,
      keyColumns: columns.map((column) => column.name ?? 'expression'),
      page: {
        block: page.block,
        level: page.level,
        isLeaf: page.isLeaf,
        isRoot: page.isRoot,
        isIgnored: page.isIgnored,
        prev: page.prev,
        next: page.next,
      },
      unreadableKeys,
      items: items.map((item, i) => ({
        offset: item.offset,
        role: item.role === 'downlink' ? 'downlink' : 'entry',
        key: keys[i],
        keyBytes: item.keyBytes,
        child: item.childBlock,
        rows: item.heapTids,
        dead: item.dead,
      })),
    }
  })
}

/** The table and its indexes; throws if the table is gone. */
async function relationsOf(db: PGliteInterface, table: TableName): Promise<Relation[]> {
  const relations = await findRelations(db, [table])
  if (relations.length === 0 || relations[0].kind !== 'table') throw new Error(`The table ${table.name} no longer exists.`)
  return relations
}

async function columnsOf(db: PGliteInterface, table: Relation): Promise<string[]> {
  const result = await query<{ name: string }>(db, `
    SELECT attname::text AS name FROM pg_attribute
    WHERE attrelid = ${table.oid} AND attnum > 0 AND NOT attisdropped ORDER BY attnum
  `)
  return result.rows.map((row) => row.name)
}

/**
 * Has Postgres write each key's values as text: each value is a SQL
 * expression from readKey, cast to its column's type. One query for the page.
 */
async function printKeys(db: PGliteInterface, types: string[], keys: (string | null)[][]): Promise<(string | null)[][]> {
  const expressions = keys.flatMap((key) =>
    key.map((value, column) => (value === null ? 'NULL' : `((${value})::${types[column]})::text`)),
  )
  if (expressions.length === 0) return keys.map(() => [])
  const result = await query<{ values: (string | null)[] }>(
    db,
    `SELECT to_json(ARRAY[${expressions.join(', ')}]::text[]) AS values`,
  )
  const printed = result.rows[0].values
  let next = 0
  return keys.map((key) => key.map(() => printed[next++]))
}

/**
 * Finds the table and its indexes and runs the reads, then evicts every page
 * of them the reads loaded into shared buffers. Inside a transaction block,
 * all of it runs in a savepoint, rolled back after: the reads change no data,
 * and a failed one then can't abort the visitor's transaction. Evictions
 * aren't part of a transaction, so the rollback doesn't undo them.
 */
async function withoutSideEffects<T>(
  db: PGliteInterface,
  table: TableName,
  read: (relations: Relation[]) => Promise<T>,
): Promise<T> {
  const status = await transactionStatus(db)
  if (status === 'E') {
    throw new Error('The current transaction failed, so Postgres won’t read anything until it ends. Run ROLLBACK first.')
  }
  const inBlock = status === 'T'
  if (inBlock) await query(db, `SAVEPOINT ${SAVEPOINT}`)
  let relations: Relation[] = []
  let before: CacheSnapshot | null = null
  try {
    relations = await relationsOf(db, table)
    before = await snapshotCache(db, relations)
    return await read(relations)
  } finally {
    // Rolling back to the savepoint undoes a failed read, so the queries below can run.
    if (inBlock) await query(db, `ROLLBACK TO SAVEPOINT ${SAVEPOINT}`)
    if (before !== null) {
      try {
        await restoreCache(db, relations, before)
      } catch (error) {
        // The page was read; only the cache keeps a few more pages than it did.
        console.error('Restoring shared buffers after reading a page failed:', error)
        if (inBlock) await query(db, `ROLLBACK TO SAVEPOINT ${SAVEPOINT}`)
      }
    }
    if (inBlock) await query(db, `RELEASE SAVEPOINT ${SAVEPOINT}`)
  }
}

const SAVEPOINT = 'sql_visualizer_pages'
