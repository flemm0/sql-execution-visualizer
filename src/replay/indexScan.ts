import type { PGliteInterface } from '@electric-sql/pglite'
import {
  parseTid,
  readBtreeMeta,
  readBtreePages,
  readHeapPages,
  readIndexColumns,
  type BtreeItem,
  type BtreePage,
  type HeapPage,
  type IndexColumn,
  type Relation,
  type Tid,
} from '../db/inspector'
import type { PlanNode } from '../db/plan'
import { query } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import type { SharedBuffers } from './buffers'
import { canReadKeys, readKey } from './indexKeys'
import type { TraceEvent } from './trace'
import { Unsupported } from './unsupported'

/*
 * Replays an Index Scan on a B-tree, the way Postgres 18's nbtree code runs one
 * forward (nbtsearch.c, nbtutils.c):
 *
 * 1. Search down from the root for the first entry that can match: on each
 *    page, compare the scan's start key with the page's keys and follow the
 *    matching downlink, until a leaf page.
 * 2. Read entries from there, left to right, moving on to the next leaf page
 *    while entries can still match. Each matching entry points at a heap row.
 * 3. Fetch each of those rows from the heap, in index order, and check the
 *    Filter on the ones the query can see.
 *
 * Steps 1 and 2 run before the query does (walkIndexScan), step 3 after
 * (replayIndexScan).
 *
 * Key values are read from the B-tree pages' bytes (indexKeys.ts), and every
 * comparison is made by Postgres, with the column's own type and collation.
 *
 * What's supported: conditions (=, <, <=, >, >=, one value each) on the
 * index's leading columns, an = on every column before the last one with a
 * condition. Lists of values (= ANY), skip scans (Postgres 18: a condition on
 * a later column without = on the ones before it) and backward scans aren't
 * replayed yet; walkIndexScan says so.
 */

type Operator = '=' | '<' | '<=' | '>' | '>='

/** One condition of an Index Cond: an index key column compared with a value. */
export interface ScanKey {
  /** The key column's position in the index, from 0. */
  column: number
  operator: Operator
  /** The value as the plan deparses it, e.g. "4242" or "'Smith'::text". */
  value: string
}

/** What the scan did in its index, in order. */
type IndexStep =
  | { kind: 'search' }
  | { kind: 'visit'; page: BtreePage; downlink: number | null }
  | { kind: 'entry'; block: number; offset: number; key: (string | null)[]; tid: Tid }

/** What fetching an index entry's heap row found. */
interface FetchedRow {
  /** The version of the row the query can see (the one pointed at, or a newer one on its page), or null. */
  visible: Tid | null
  /** Whether it passed the Filter; false if nothing was visible. */
  matched: boolean
}

/** A B-tree page whose keys have been read, and compared with the scan's keys by Postgres. */
interface ComparedPage {
  page: BtreePage
  items: ComparedItem[]
}

interface ComparedItem {
  item: BtreeItem
  /** How many key columns it has: all of them for an entry, maybe fewer for a high key or downlink. */
  columns: number
  /** Its key values as Postgres writes them, null for NULL. */
  text: (string | null)[]
  /**
   * For each scan key, how the item's value in the key's column compares
   * with the key's value: -1 (less), 0 (equal) or 1 (greater); null if the
   * item's value is NULL. Undefined if the item doesn't have that column.
   */
  signs: (number | null)[]
}

/** The key a search down the index starts from (_bt_first). */
interface StartKey {
  /** For each leading column in turn, the scan key (its position in the scan's keys) to compare with. */
  keys: number[]
  /**
   * False: look for the first entry at or after the start key (= or >=).
   * True: the first entry after it (>).
   */
  nextKey: boolean
}

/**
 * Where an index scan goes in its index, found before the query runs: running
 * it can change the index (see markedDead), and the replay has to see the
 * index as the scan found it.
 */
export interface IndexWalk {
  /** The index and condition walked for, to check the plan that ran is the same. */
  indexName: string
  indexCond: string | null
  steps: IndexStep[]
}

/**
 * Walks an index scan's index as Postgres will (steps 1 and 2 above),
 * reading each page it reaches. Throws Unsupported for a scan the replay
 * can't handle yet.
 */
export async function walkIndexScan(db: PGliteInterface, node: PlanNode, index: Relation): Promise<IndexWalk> {
  if (node.relation === null || node.indexName === null) throw new Error(`${node.title} names no index`)
  if (index.accessMethod !== 'btree') {
    throw new Unsupported(`Animation isn’t available yet for ${index.accessMethod} indexes.`)
  }
  if (node.backward) throw new Unsupported('Animation isn’t available yet for backward index scans.')
  const columns = await readIndexColumns(db, index)
  const keys = parseIndexCond(node.indexCond, node.relation.alias, columns)
  return { indexName: node.indexName, indexCond: node.indexCond, steps: await walkIndex(db, index, columns, keys) }
}

/**
 * The trace of an Index Scan at the top of the plan, from its walk of the
 * index, after the query has run: fetches the rows the walk found entries
 * for, and finds the entries the scan marked dead.
 */
export async function replayIndexScan(
  db: PGliteInterface,
  node: PlanNode,
  table: Relation,
  index: Relation,
  walk: IndexWalk,
  buffers: SharedBuffers,
): Promise<TraceEvent[]> {
  const tids = walk.steps.flatMap((step) => (step.kind === 'entry' ? [step.tid] : []))
  const rows = await fetchRows(db, node, table, tids)
  const dead = await markedDead(db, index, walk.steps)
  return [...indexScanEvents(node, table, index, walk.steps, rows, dead, buffers)]
}

/**
 * The entries the query marked dead, by leaf page. When an index scan finds
 * that no transaction can see an entry's row any more (deleted or updated,
 * and committed), it marks the entry dead on the leaf page, so later scans
 * skip it without fetching the row ("killed" index tuples). Found by reading
 * the leaf pages again and comparing with the walk, read before the query ran.
 */
async function markedDead(db: PGliteInterface, index: Relation, steps: IndexStep[]): Promise<Map<number, number[]>> {
  const leaves = new Map<number, BtreePage>()
  for (const step of steps) if (step.kind === 'visit' && step.page.isLeaf) leaves.set(step.page.block, step.page)
  const dead = new Map<number, number[]>()
  for (const now of await readBtreePages(db, index, [...leaves.keys()])) {
    const before = leaves.get(now.block) as BtreePage
    const wasDead = new Map(before.items.map((item) => [item.offset, item.dead]))
    const marked = now.items.filter((item) => item.dead && wasDead.get(item.offset) === false).map((item) => item.offset)
    if (marked.length > 0) dead.set(now.block, marked)
  }
  return dead
}

/**
 * Reads an Index Cond into scan keys, e.g. "((orders.id >= 1000) AND
 * (orders.id <= 2000))" into id >= 1000 and id <= 2000, sorted by column.
 * Throws Unsupported for a condition, or an index, the replay can't handle yet.
 */
export function parseIndexCond(indexCond: string | null, alias: string, columns: IndexColumn[]): ScanKey[] {
  const keyColumns = columns.filter((column) => column.isKey)
  for (const column of keyColumns) {
    if (!canReadKeys(column.type)) throw new Unsupported(`Animation isn’t available yet for indexes on ${column.type} columns.`)
    if (column.descending || column.nullsFirst) {
      throw new Unsupported('Animation isn’t available yet for indexes sorted DESC or NULLS FIRST.')
    }
    if (!column.defaultOrder) {
      throw new Unsupported('Animation isn’t available yet for indexes with their own operator class (like text_pattern_ops).')
    }
  }

  const keys = (indexCond === null ? [] : conjuncts(indexCond)).map((condition) =>
    parseCondition(condition, alias, keyColumns),
  )

  keyColumns.forEach((_, column) => {
    const own = keys.filter((key) => key.column === column)
    const equal = own.filter((key) => key.operator === '=').length
    const lower = own.filter((key) => key.operator === '>' || key.operator === '>=').length
    const upper = own.filter((key) => key.operator === '<' || key.operator === '<=').length
    if (equal > 1 || lower > 1 || upper > 1 || (equal === 1 && own.length > 1)) {
      throw new Unsupported('Animation isn’t available yet for several conditions of the same kind on one index column.')
    }
    const conditionLater = keys.some((key) => key.column > column)
    if (conditionLater && equal === 0) {
      throw new Unsupported(
        'Animation isn’t available yet for skip scans, where an index column without an = condition comes before a column with a condition.',
      )
    }
  })

  // Postgres checks each column's keys in this order (_bt_preprocess_keys).
  const order: Operator[] = ['>', '>=', '=', '<=', '<']
  return keys.sort((a, b) => a.column - b.column || order.indexOf(a.operator) - order.indexOf(b.operator))
}

/** One condition, e.g. "orders.id >= 1000": a key column on the left, as Postgres writes index conditions. */
function parseCondition(condition: string, alias: string, keyColumns: IndexColumn[]): ScanKey {
  const found = findOperator(condition)
  if (found === null) throw new Unsupported(`Animation isn’t available yet for the index condition ${condition}.`)
  const { operator, at } = found
  const left = condition.slice(0, at)
  const value = condition.slice(at + operator.length + 2)
  if (operator === '<>') throw new Unsupported(`Animation isn’t available yet for the index condition ${condition}.`)
  if (/^(ANY|ALL) \(/.test(value)) {
    throw new Unsupported('Animation isn’t available yet for index conditions with a list of values (= ANY).')
  }
  // A varchar column is compared as text: "(t.code)::text".
  const cast = /^\((.*)\)::text$/.exec(left)
  const match = QUALIFIED_NAME.exec(cast === null ? left : cast[1])
  const column =
    match && unquote(match[1]) === alias
      ? keyColumns.findIndex((key) => key.name === unquote(match[2]) && (cast === null || key.type === 'varchar'))
      : -1
  if (column === -1) throw new Unsupported('Animation isn’t available yet for index conditions on expressions.')
  return { column, operator, value }
}

/** A name as Postgres writes it, e.g. orders or "Bin No", and a qualified one: orders.id. */
const NAME = String.raw`(?:"(?:[^"]|"")*"|[^\s."()]+)`
const QUALIFIED_NAME = new RegExp(`^(${NAME})\\.(${NAME})$`)

function unquote(name: string) {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name
}

/** The parts of a deparsed AND: "((a >= 1) AND (a <= 2))" gives ["a >= 1", "a <= 2"], "(a = 1)" gives ["a = 1"]. */
function conjuncts(condition: string): string[] {
  const inner = unwrap(condition)
  const separators = topLevel(inner).filter((i) => inner.startsWith(' AND ', i))
  if (separators.length === 0) return [inner]
  const parts: string[] = []
  let from = 0
  for (const at of separators) {
    parts.push(inner.slice(from, at))
    from = at + ' AND '.length
  }
  parts.push(inner.slice(from))
  return parts.map(unwrap)
}

/** The comparison operator outside any parentheses or quotes, e.g. ">=" in "orders.id >= 1000". */
function findOperator(condition: string): { operator: Operator | '<>'; at: number } | null {
  for (const at of topLevel(condition)) {
    if (condition[at] !== ' ') continue
    for (const operator of ['>=', '<=', '<>', '=', '<', '>'] as const) {
      if (condition.startsWith(` ${operator} `, at)) return { operator, at }
    }
  }
  return null
}

/** "(a = 1)" without its outer parentheses; anything else as it is. */
function unwrap(text: string) {
  const positions = topLevel(text)
  // The outer parentheses enclose everything if no character but the last is outside them.
  const enclosed = text.startsWith('(') && text.endsWith(')') && positions.length === 2
  return enclosed ? text.slice(1, -1) : text
}

/** The positions in SQL text outside parentheses, string literals and quoted names (an opening or closing parenthesis counts as outside). */
function topLevel(text: string): number[] {
  const positions: number[] = []
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote !== null) {
      if (char === quote) quote = null // a doubled quote closes and reopens: same result
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '(') {
      if (depth === 0) positions.push(i)
      depth++
      continue
    } else if (char === ')') {
      depth--
      if (depth === 0) positions.push(i)
      continue
    }
    if (depth === 0 && quote === null) positions.push(i)
  }
  return positions
}

/** Walks the index as the scan does, reading each page it reaches. */
async function walkIndex(
  db: PGliteInterface,
  index: Relation,
  columns: IndexColumn[],
  keys: ScanKey[],
): Promise<IndexStep[]> {
  const read = async (block: number) => comparePage(db, (await readBtreePages(db, index, [block]))[0], columns, keys)
  const start = startKey(keys)
  const steps: IndexStep[] = [{ kind: 'search' }]
  // Postgres keeps the metapage in memory after planning, so reading it isn't part of the scan.
  const meta = await readBtreeMeta(db, index)

  // Down to a leaf.
  let current = await read(meta.fastRoot)
  for (;;) {
    const { page } = current
    // A page that split after its parent was read, or was deleted: move right (_bt_moveright).
    if (page.next !== null && (page.isIgnored || (start !== null && sortsAfterHighKey(current, start)))) {
      steps.push({ kind: 'visit', page, downlink: null })
      current = await read(page.next)
      continue
    }
    if (page.isLeaf) break
    // With no start key, the leftmost child (_bt_endpoint).
    const position = start === null ? firstData(page) : firstNotBefore(current, start) - 1
    const downlink = current.items[position].item
    steps.push({ kind: 'visit', page, downlink: downlink.offset })
    current = await read(downlink.childBlock as number)
  }
  steps.push({ kind: 'visit', page: current.page, downlink: null })

  // Along the leaves.
  let from = start === null ? firstData(current.page) : firstNotBefore(current, start)
  for (;;) {
    const { matches, more } = scanLeaf(current, from, keys)
    for (const { item, text } of matches) {
      for (const tid of item.heapTids) {
        steps.push({ kind: 'entry', block: current.page.block, offset: item.offset, key: text, tid })
      }
    }
    if (!more) break
    // Deleted pages are skipped, but reading them still costs a buffer access.
    do {
      current = await read(current.page.next as number)
      steps.push({ kind: 'visit', page: current.page, downlink: null })
    } while (current.page.isIgnored && current.page.next !== null)
    if (current.page.isIgnored) break
    from = firstData(current.page)
  }
  return steps
}

/**
 * Reads each item's key from a page, and asks Postgres, in one query, how
 * each compares with each scan key's value, and how it writes each value.
 */
async function comparePage(
  db: PGliteInterface,
  page: BtreePage,
  columns: IndexColumn[],
  keys: ScanKey[],
): Promise<ComparedPage> {
  const keyColumns = columns.filter((column) => column.isKey)
  const decoded = page.items.map((item) => {
    const count = item.keyColumns ?? keyColumns.length
    return { item, count, values: readKey(item.keyBytes, item.hasNulls, columns, count) }
  })
  /** The items' values in one column, as SQL VALUES rows: (position on the page, value). */
  const valueRows = (column: number) =>
    decoded.flatMap(({ count, values }, i) =>
      column < count ? [`(${i}, CAST(${values[column] ?? 'NULL'} AS ${keyColumns[column].type}))`] : [],
    )

  const selects: string[] = []
  keys.forEach((key, k) => {
    const rows = valueRows(key.column)
    if (rows.length === 0) return
    const collation = keyColumns[key.column].collation
    const value = collation === null ? 'v' : `v COLLATE ${collation}`
    selects.push(`SELECT 'sign' AS what, ${k} AS k, i,
      CASE WHEN v IS NULL THEN NULL WHEN ${value} < ${key.value} THEN -1 WHEN ${value} = ${key.value} THEN 0 ELSE 1 END AS sign,
      NULL::text AS text
      FROM (VALUES ${rows.join(', ')}) AS t(i, v)`)
  })
  keyColumns.forEach((_, column) => {
    const rows = valueRows(column)
    if (rows.length === 0) return
    selects.push(`SELECT 'text', ${column}, i, NULL::int, v::text FROM (VALUES ${rows.join(', ')}) AS t(i, v)`)
  })

  const items: ComparedItem[] = decoded.map(({ item, count }) => ({ item, columns: count, text: [], signs: [] }))
  if (selects.length > 0) {
    const result = await query<{ what: string; k: number; i: number; sign: number | null; text: string | null }>(
      db,
      selects.join('\nUNION ALL\n'),
    )
    for (const row of result.rows) {
      if (row.what === 'sign') items[row.i].signs[row.k] = row.sign
      else items[row.i].text[row.k] = row.text
    }
  }
  return { page, items }
}

/** Where the search starts from: the = keys on the leading columns, then one >= or > key if there is one (_bt_first). */
function startKey(keys: ScanKey[]): StartKey | null {
  const start: StartKey = { keys: [], nextKey: false }
  for (let column = 0; ; column++) {
    const own = keys.map((key, k) => ({ key, k })).filter(({ key }) => key.column === column)
    const equal = own.find(({ key }) => key.operator === '=')
    if (equal) {
      start.keys.push(equal.k)
      continue
    }
    const lower = own.find(({ key }) => key.operator === '>' || key.operator === '>=')
    if (lower) {
      start.keys.push(lower.k)
      start.nextKey = lower.key.operator === '>'
    }
    break
  }
  return start.keys.length === 0 ? null : start
}

/**
 * How the start key compares with an item (_bt_compare): positive if it
 * sorts after it, negative before, 0 if equal in every column the two share.
 */
function compareWithStart(item: ComparedItem, start: StartKey): number {
  const shared = Math.min(item.columns, start.keys.length)
  for (let column = 0; column < shared; column++) {
    const sign = item.signs[start.keys[column]]
    // NULLs sort after every value.
    if (sign === null) return -1
    if (sign !== 0) return -sign
  }
  // A column the item doesn't have stands for "minus infinity": the start key is after it.
  if (start.keys.length > item.columns) return 1
  // Equal to a high key or downlink without a heap row: every entry to its
  // left is lower, so the search can go right (a forward scan wants no row "minus infinity").
  if (item.item.role !== 'entry' && start.keys.length === item.columns && !item.item.hasHeapTid) return 1
  return 0
}

/** Whether the start key is at or after a page's high key, so the search has to move right (_bt_moveright). */
function sortsAfterHighKey(page: ComparedPage, start: StartKey) {
  return compareWithStart(page.items[0], start) >= (start.nextKey ? 0 : 1)
}

/**
 * The position of the first item the search can't skip (_bt_binsrch): the
 * first the start key doesn't sort after (or, for a > key, sorts before). On
 * an internal page, the search follows the downlink just before it; the first
 * downlink stands for "minus infinity", which every key sorts after.
 */
function firstNotBefore(page: ComparedPage, start: StartKey): number {
  const first = firstData(page.page)
  const threshold = start.nextKey ? 0 : 1
  for (let i = first; i < page.items.length; i++) {
    const result = i === first && !page.page.isLeaf ? 1 : compareWithStart(page.items[i], start)
    if (result < threshold) return i
  }
  return page.items.length
}

/** The position of a page's first downlink or entry: after the high key, which every page but the rightmost has. */
function firstData(page: BtreePage) {
  return page.next === null ? 0 : 1
}

/**
 * Reads a leaf page's entries from `from` on (_bt_readpage), and returns the
 * ones that match every scan key, and whether the next page can have more.
 * An entry above an upper bound (or not equal to an = key) ends the scan;
 * one below a lower bound is skipped. Entries marked dead are skipped
 * without a look. When the whole page matched, its high key decides whether
 * to go on.
 */
function scanLeaf(page: ComparedPage, from: number, keys: ScanKey[]) {
  const matches: ComparedItem[] = []
  for (const item of page.items.slice(from)) {
    if (item.item.dead) continue
    const result = checkKeys(item, keys)
    if (result === 'stop') return { matches, more: false }
    if (result === 'match') matches.push(item)
  }
  const more = page.page.next !== null && checkKeys(page.items[0], keys) !== 'stop'
  return { matches, more }
}

function checkKeys(item: ComparedItem, keys: ScanKey[]): 'match' | 'skip' | 'stop' {
  for (const [k, key] of keys.entries()) {
    // A high key may not have every column: the next page's entries can have any value there.
    if (key.column >= item.columns) continue
    const sign = item.signs[k]
    // NULLs sort last, so after the first one nothing matches.
    if (sign === null) return 'stop'
    if (satisfies(sign, key.operator)) continue
    return key.operator === '>' || key.operator === '>=' ? 'skip' : 'stop'
  }
  return 'match'
}

/** Whether a value that compares as `sign` with a key's value passes the key. */
function satisfies(sign: number, operator: Operator) {
  switch (operator) {
    case '<':
      return sign < 0
    case '<=':
      return sign <= 0
    case '=':
      return sign === 0
    case '>=':
      return sign >= 0
    case '>':
      return sign > 0
  }
}

/**
 * Asks Postgres which of these rows the query can see, and whether they pass
 * the node's Filter. A row updated in place (a HOT update) is followed to the
 * version the query can see, through its page's line pointers.
 */
async function fetchRows(
  db: PGliteInterface,
  node: PlanNode,
  table: Relation,
  tids: Tid[],
): Promise<Map<string, FetchedRow>> {
  const rows = new Map<string, FetchedRow>(tids.map((tid) => [tidText(tid), { visible: null, matched: false }]))
  const direct = await visibleRows(db, node, tids)
  for (const [tid, matched] of direct) rows.set(tid, { visible: parseTid(tid), matched })

  const hidden = tids.filter((tid) => !direct.has(tidText(tid)))
  if (hidden.length === 0) return rows
  const pages = new Map<number, HeapPage>()
  for (const page of await readHeapPages(db, table, hidden.map((tid) => tid.block))) pages.set(page.block, page)
  const chains = hidden.map((tid) => ({
    tid,
    versions: hotChain(pages.get(tid.block) as HeapPage, tid.offset).map((offset) => ({ block: tid.block, offset })),
  }))
  const visible = await visibleRows(db, node, chains.flatMap((chain) => chain.versions))
  for (const { tid, versions } of chains) {
    const version = versions.find((candidate) => visible.has(tidText(candidate)))
    if (version) rows.set(tidText(tid), { visible: version, matched: visible.get(tidText(version)) as boolean })
  }
  return rows
}

/** Of these rows, the ones the query can see, each with whether it passes the node's Filter. */
async function visibleRows(db: PGliteInterface, node: PlanNode, tids: Tid[]): Promise<Map<string, boolean>> {
  if (tids.length === 0 || node.relation === null) return new Map()
  const { schema, name, alias } = node.relation
  const table = `ONLY ${quoteIdentifier(schema)}.${quoteIdentifier(name)} AS ${quoteIdentifier(alias)}`
  const result = await query<{ tid: string; matched: boolean }>(
    db,
    `SELECT ${quoteIdentifier(alias)}.ctid::text AS tid, coalesce(${node.filter ?? 'true'}, false) AS matched
     FROM ${table}
     WHERE ${quoteIdentifier(alias)}.ctid = ANY (ARRAY[${tids.map((tid) => `'${tidText(tid)}'`).join(', ')}]::tid[])`,
  )
  return new Map(result.rows.map((row) => [row.tid, row.matched]))
}

/** HEAP_HOT_UPDATED (htup_details.h): this version was updated in place; the next one is on the same page. */
const HEAP_HOT_UPDATED = 0x4000

/**
 * The versions of a row an index entry can lead to: the one it points at,
 * then each newer version a HOT update put on the same page. After pruning,
 * the entry's line pointer may redirect to the first version still there.
 */
function hotChain(page: HeapPage, offset: number): number[] {
  const items = new Map(page.items.map((item) => [item.offset, item]))
  const chain: number[] = []
  let item = items.get(offset)
  if (item?.state === 'redirect' && item.redirectTo !== null) item = items.get(item.redirectTo)
  while (item !== undefined && item.state === 'normal' && !chain.includes(item.offset)) {
    chain.push(item.offset)
    const next = item.ctid
    if (((item.infomask2 ?? 0) & HEAP_HOT_UPDATED) === 0 || next === null || next.block !== page.block) break
    item = items.get(next.offset)
  }
  return chain
}

/**
 * The trace: each index page the scan reads (a hit or a read), each matching
 * entry, and for each, the heap row it fetches and what it finds. A heap page
 * is a buffer access only when the scan moves to it from another page: while
 * consecutive entries point into the same page, the scan keeps it pinned.
 *
 * When the scan leaves a leaf page (for the next one, or at the end) after
 * finding rows nobody can see, it reads the page again to mark their entries
 * dead (_bt_killitems): Postgres 18 lets go of a leaf page once it has its
 * matches, so marking them takes another buffer access.
 */
export function* indexScanEvents(
  node: PlanNode,
  table: Relation,
  index: Relation,
  steps: IndexStep[],
  rows: Map<string, FetchedRow>,
  dead: Map<number, number[]>,
  buffers: SharedBuffers,
): Generator<TraceEvent> {
  yield { type: 'node.start', node: node.id }
  let pinned: number | null = null
  let leaf: number | null = null
  let resultIndex = 0
  function* markDead(): Generator<TraceEvent> {
    const offsets = leaf === null ? undefined : dead.get(leaf)
    if (leaf === null || offsets === undefined) return
    const page = { relation: index.oid, block: leaf }
    yield { type: buffers.access(page), node: node.id, page }
    yield { type: 'index.markDead', node: node.id, page, offsets }
  }

  for (const step of steps) {
    if (step.kind === 'search') {
      yield { type: 'index.search', node: node.id, index: index.oid }
    } else if (step.kind === 'visit') {
      if (step.page.isLeaf) {
        yield* markDead()
        leaf = step.page.block
      }
      const page = { relation: index.oid, block: step.page.block }
      yield { type: buffers.access(page), node: node.id, page }
      yield { type: 'index.visit', node: node.id, page, level: step.page.level, downlink: step.downlink }
    } else {
      const row = { relation: table.oid, ...step.tid }
      const page = { relation: index.oid, block: step.block }
      yield { type: 'index.entry', node: node.id, page, offset: step.offset, key: step.key, row }
      if (step.tid.block !== pinned) {
        pinned = step.tid.block
        const heapPage = { relation: table.oid, block: step.tid.block }
        yield { type: buffers.access(heapPage), node: node.id, page: heapPage }
      }
      const fetched = rows.get(tidText(step.tid)) as FetchedRow
      const visible = fetched.visible === null ? null : { relation: table.oid, ...fetched.visible }
      yield { type: 'heap.tuple', node: node.id, row, visible, matched: fetched.matched }
      if (visible !== null && fetched.matched) {
        yield { type: 'row.emit', node: node.id, row: visible, resultIndex: resultIndex++ }
      }
    }
  }
  yield* markDead()
  yield { type: 'node.finish', node: node.id }
}

/** A tid as Postgres writes it, "(12,3)". */
function tidText(tid: Tid) {
  return `(${tid.block},${tid.offset})`
}
