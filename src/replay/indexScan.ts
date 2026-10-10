import type { PGliteInterface } from '@electric-sql/pglite'
import {
  parseTid,
  readBtreePages,
  readHeapPages,
  readIndexColumns,
  type BtreePage,
  type HeapPage,
  type IndexColumn,
  type Relation,
  type Tid,
} from '../db/inspector'
import type { PlanNode } from '../db/plan'
import { query } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import { walkBtree, type IndexStep, type ScanKey } from './btreeScan'
import type { SharedBuffers } from './buffers'
import { canReadKeys } from './indexKeys'
import type { TraceEvent } from './trace'
import { Unsupported } from './unsupported'

/*
 * Replays an Index Scan on a B-tree, the way Postgres 18's nbtree code runs one
 * forward:
 *
 * 1. Search down from the root for the first entry that can match, then read
 *    entries from there, left to right, moving on to the next leaf page while
 *    entries can still match. Each matching entry points at a heap row. With
 *    a list of values (= ANY) or a skip scan, the scan may search down from
 *    the root again for the next value (btreeScan.ts).
 * 2. Fetch each of those rows from the heap, in index order, and check the
 *    Filter on the ones the query can see.
 *
 * Step 1 runs before the query does (walkIndexScan), step 2 after
 * (replayIndexScan).
 *
 * What's supported: conditions =, <, <=, >, >= (one value each) and = ANY
 * (a list) on the index's key columns, at most one of each kind per column,
 * and = or = ANY alone. Backward scans aren't replayed yet; walkIndexScan
 * says so.
 */

/** What fetching an index entry's heap row found. */
interface FetchedRow {
  /** The version of the row the query can see (the one pointed at, or a newer one on its page), or null. */
  visible: Tid | null
  /** Whether it passed the Filter; false if nothing was visible. */
  matched: boolean
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
  /** Whether it's a skip scan: the scan moves through every value of an index column without a condition of =. */
  skipScan: boolean
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
  return { indexName: node.indexName, indexCond: node.indexCond, ...(await walkBtree(db, index, columns, keys)) }
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
async function markedDead(db: PGliteInterface, index: Relation, steps: IndexStep[]): Promise<Map<number, Set<number>>> {
  const leaves = new Map<number, BtreePage>()
  for (const step of steps) if (step.kind === 'visit' && step.page.isLeaf) leaves.set(step.page.block, step.page)
  const dead = new Map<number, Set<number>>()
  for (const now of await readBtreePages(db, index, [...leaves.keys()])) {
    const before = leaves.get(now.block) as BtreePage
    const wasDead = new Map(before.items.map((item) => [item.offset, item.dead]))
    const marked = now.items.filter((item) => item.dead && wasDead.get(item.offset) === false).map((item) => item.offset)
    if (marked.length > 0) dead.set(now.block, new Set(marked))
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
    const equal = own.filter((key) => key.operator === '=' || key.operator === '= ANY').length
    const lower = own.filter((key) => key.operator === '>' || key.operator === '>=').length
    const upper = own.filter((key) => key.operator === '<' || key.operator === '<=').length
    if (equal > 1 || lower > 1 || upper > 1 || (equal === 1 && own.length > 1)) {
      throw new Unsupported('Animation isn’t available yet for several conditions of the same kind on one index column.')
    }
  })

  // Postgres checks each column's keys in this order (_bt_preprocess_keys).
  const order: ScanKey['operator'][] = ['>', '>=', '=', '= ANY', '<=', '<']
  return keys.sort((a, b) => a.column - b.column || order.indexOf(a.operator) - order.indexOf(b.operator))
}

/** One condition, e.g. "orders.id >= 1000": a key column on the left, as Postgres writes index conditions. */
function parseCondition(condition: string, alias: string, keyColumns: IndexColumn[]): ScanKey {
  const found = findOperator(condition)
  if (found === null) throw new Unsupported(`Animation isn’t available yet for the index condition ${condition}.`)
  const { at } = found
  let operator: ScanKey['operator'] | '<>' = found.operator
  const left = condition.slice(0, at)
  let value = condition.slice(at + operator.length + 2)
  if (operator === '<>') throw new Unsupported(`Animation isn’t available yet for the index condition ${condition}.`)
  // A list of values: "orders.id = ANY ('{1,2}'::integer[])".
  const list = /^(ANY|ALL) \((.*)\)$/s.exec(value)
  if (list !== null) {
    if (operator !== '=' || list[1] !== 'ANY') {
      throw new Unsupported(`Animation isn’t available yet for the index condition ${condition}.`)
    }
    operator = '= ANY'
    value = list[2]
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
function findOperator(condition: string): { operator: '<' | '<=' | '=' | '>=' | '>' | '<>'; at: number } | null {
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
 * When the scan leaves a leaf page (for the next one, a new search from the
 * root, or the end) after finding rows nobody can see, it reads the page
 * again to mark their entries dead (_bt_killitems): Postgres 18 lets go of a
 * leaf page once it has its matches, so marking them takes another buffer
 * access.
 */
export function* indexScanEvents(
  node: PlanNode,
  table: Relation,
  index: Relation,
  steps: IndexStep[],
  rows: Map<string, FetchedRow>,
  dead: Map<number, Set<number>>,
  buffers: SharedBuffers,
): Generator<TraceEvent> {
  yield { type: 'node.start', node: node.id }
  let pinned: number | null = null
  /** The leaf page the scan is on, and the entries it returned from it. */
  let leaf: { block: number; returned: number[] } | null = null
  let resultIndex = 0
  function* leaveLeaf(): Generator<TraceEvent> {
    const marked = leaf === null ? [] : unique(leaf.returned.filter((offset) => dead.get(leaf?.block as number)?.has(offset)))
    if (leaf !== null && marked.length > 0) {
      const page = { relation: index.oid, block: leaf.block }
      yield { type: buffers.access(page), node: node.id, page }
      yield { type: 'index.markDead', node: node.id, page, offsets: marked }
    }
    leaf = null
  }

  for (const step of steps) {
    if (step.kind === 'search') {
      yield* leaveLeaf()
      yield { type: 'index.search', node: node.id, index: index.oid }
    } else if (step.kind === 'visit') {
      if (step.page.isLeaf) {
        yield* leaveLeaf()
        leaf = { block: step.page.block, returned: [] }
      }
      const page = { relation: index.oid, block: step.page.block }
      yield { type: buffers.access(page), node: node.id, page }
      yield { type: 'index.visit', node: node.id, page, level: step.page.level, downlink: step.downlink }
    } else {
      leaf?.returned.push(step.offset)
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
  yield* leaveLeaf()
  yield { type: 'node.finish', node: node.id }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

/** A tid as Postgres writes it, "(12,3)". */
function tidText(tid: Tid) {
  return `(${tid.block},${tid.offset})`
}
