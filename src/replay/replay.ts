import type { PGliteInterface } from '@electric-sql/pglite'
import { readVisibilityMap, type CacheSnapshot, type Relation, type VisibilityMap } from '../db/inspector'
import type { Plan, PlanNode, ScannedTable } from '../db/plan'
import { query } from '../db/query'
import { bitmapScanEvents } from './bitmapScan'
import { SharedBuffers } from './buffers'
import { readHeapInternals } from './heapInternals'
import { entryTids, fetchIndexScan, fetchRows, indexScanEvents, walkIndexScan, type IndexWalk } from './indexScan'
import { childRowsNeeded, limitEvents } from './limit'
import { readLimits, type LimitSettings } from './limits'
import { nestedLoopEvents, wholeRow, type InnerLoop } from './nestedLoop'
import { bindNode, constantOf, subtreeReferences } from './params'
import { readValues } from './rowValues'
import { scanPages, seqScanEvents, seqScanStop } from './seqScan'
import { rankRows, sortContents, sortEvents, unsupportedSort } from './sort'
import type { HeapPageContents, IndexPageContents, RowRef, SortContents, Trace, TraceEvent } from './trace'
import { Unsupported } from './unsupported'
import { allNodes, validate, type Validation } from './validate'

/*
 * The replay engine: rebuilds, step by step, what the executor did for a
 * query, from the real plan, the real pages and the cache as the query found
 * it, then checks the result against Postgres (see validate.ts).
 */

/** What became of replaying a query. */
export type Replay =
  | { status: 'replayed'; trace: Trace; validation: Validation }
  /** The plan has a node, or a feature, the replay engine can't replay yet. */
  | { status: 'unsupported'; reason: string }
  /** Replaying went wrong, e.g. a helper query failed. */
  | { status: 'failed'; message: string }

export interface ReplayInput {
  /** The query, as it ran. */
  sql: string
  plan: Plan
  /** The query's tables and indexes. */
  relations: Relation[]
  /** The cache just before execution, after planning. */
  cacheBefore: CacheSnapshot
  /** The real result: its column count, the rows the results pane shows, and how many there are in all. */
  columnCount: number
  resultRows: (string | null)[][]
  totalRows: number
  /** What prepareReplay found before the query ran; null if it had nothing to do. */
  prepared: Prepared | null
}

/**
 * What the replay found before the query ran: each index scan's walk of its
 * index, by walkKey (an inner scan with parameters walks once per loop, for
 * its values), or the error that stopped it (Unsupported, for one), to
 * report with the replay.
 */
export type Prepared = { status: 'walked'; walks: Map<string, WalkedIndex> } | { status: 'error'; error: unknown }

/** An index scan's walk of its index, and for an Index Only Scan, the table's visibility map (null for other index scans). */
export interface WalkedIndex {
  walk: IndexWalk
  visibilityMap: VisibilityMap | null
}

/** Node types the replay engine can replay. */
export const REPLAYABLE = new Set([
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Sort',
  'Limit',
  'Nested Loop',
])

/** Node types that read a table. */
const TABLE_SCANS = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'])

/** Node types that walk a B-tree index. */
const INDEX_WALKS = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'])

const SUBQUERIES = 'Animation isn’t available yet for subqueries.'

/**
 * A node's part of the trace, ready to play: a function that makes its
 * events as they're asked for, in the executor's order. Each page access is
 * decided a hit or a read at that moment, so when two scans read the same
 * table (a join of a table with itself), the first to ask reads it. A
 * Nested Loop plays its inner side once per loop.
 */
type Play = (buffers: SharedBuffers) => Iterable<TraceEvent>

const nothing: Play = () => []

/**
 * The Limit and Sort nodes at the top of the plan, each over one child, from
 * the top down.
 */
function nodesAbove(root: PlanNode): PlanNode[] {
  const above: PlanNode[] = []
  let node = root
  while ((node.nodeType === 'Limit' || node.nodeType === 'Sort') && node.children.length === 1) {
    above.push(node)
    node = node.children[0]
  }
  return above
}

/**
 * Why the replay engine can't replay a plan of this shape yet, or null if it
 * can. It can replay Limit and Sort nodes at the top, each over one child,
 * above one scan; or inner Nested Loops, nested in any way, over scans (see
 * unsupportedBelow). A node with more children than its type has runs a
 * subquery (an InitPlan or SubPlan).
 */
function unsupportedShape(root: PlanNode): string | null {
  const above = nodesAbove(root)
  const below = above.length === 0 ? root : above[above.length - 1].children[0]
  if (below.nodeType === 'Limit' || below.nodeType === 'Sort') return SUBQUERIES
  if (below.nodeType === 'Nested Loop' && above.length > 0) {
    return `Animation isn’t available yet for a ${above[above.length - 1].nodeType} above a join.`
  }
  return unsupportedBelow(below)
}

/** Why a join or scan can't be replayed yet, or null if it can (see unsupportedShape). */
function unsupportedBelow(node: PlanNode): string | null {
  if (node.nodeType === 'Nested Loop') {
    // The title says which join: "Nested Loop Left Join", "Nested Loop Semi Join".
    if (node.title !== 'Nested Loop') return `Animation isn’t available yet for ${node.title}.`
    if (node.children.length !== 2) return SUBQUERIES
    if (node.innerUnique && node.joinFilter !== null) {
      return 'Animation isn’t available yet for a Nested Loop with both Inner Unique and a Join Filter.'
    }
    return unsupportedBelow(node.children[0]) ?? unsupportedBelow(node.children[1])
  }
  if (node.nodeType === 'Bitmap Heap Scan') {
    const [child] = node.children
    const single = node.children.length === 1 && child.nodeType === 'Bitmap Index Scan' && child.children.length === 0
    return single ? null : SUBQUERIES
  }
  if (node.nodeType === 'Limit' || node.nodeType === 'Sort') {
    return `Animation isn’t available yet for a ${node.nodeType} inside a join.`
  }
  return TABLE_SCANS.has(node.nodeType) && node.children.length === 0 ? null : SUBQUERIES
}

/**
 * The tables a node's rows come from, one per scan under it, in plan order
 * (a join's outer side first): a row it passes up is one row of each. A
 * table joined with itself appears twice, once per alias.
 */
function scansOf(node: PlanNode): ScannedTable[] {
  if (TABLE_SCANS.has(node.nodeType) && node.relation !== null) return [node.relation]
  return node.children.flatMap(scansOf)
}

/** Whether an inner side of a Nested Loop in the plan uses its outer rows' values (parameters). */
function hasParameters(node: PlanNode): boolean {
  if (node.nodeType === 'Nested Loop' && node.children.length === 2) {
    const [outer, inner] = node.children
    if (subtreeReferences(inner, new Set(scansOf(outer).map((table) => table.alias))).length > 0) return true
  }
  return node.children.some(hasParameters)
}

/**
 * The part of a replay that has to happen before the query runs (in the
 * order of ARCHITECTURE.md, after the cache snapshot and before execution).
 * Running an index scan can change its index: it marks entries whose rows
 * nobody can see any more as dead, and later scans skip them. So each index
 * scan's index is walked first, as the query will find it; a Bitmap Index
 * Scan's too, though it marks nothing dead, so every replay sees its index
 * the same way. An Index Only Scan also reads the visibility map bits of the
 * heap pages its entries point into, as the query will find them. `plan`
 * comes from a plain EXPLAIN (VERBOSE). Reading the pages loads them into
 * shared buffers, so the caller evicts them again before running the query.
 *
 * An inner index scan with parameters searches its index once per outer
 * row, for that row's values. To know them, the whole plan is replayed now
 * (reading rows changes nothing), and every walk it makes is kept.
 *
 * Returns null when there's nothing to do before the query runs.
 */
export async function prepareReplay(db: PGliteInterface, plan: Plan, relations: Relation[]): Promise<Prepared | null> {
  const root = plan.root
  const nodes = allNodes(root)
  if (nodes.some((node) => !REPLAYABLE.has(node.nodeType)) || unsupportedShape(root) !== null) return null
  const indexScans = nodes.filter((node) => INDEX_WALKS.has(node.nodeType))
  if (indexScans.length === 0) return null
  const replayer = new PlanReplayer(db, relations, null, root, new Map())
  try {
    if (hasParameters(root)) await replayer.build(root, null)
    else for (const node of indexScans) await replayer.walkOnly(node)
    return { status: 'walked', walks: replayer.walks }
  } catch (error) {
    return { status: 'error', error }
  }
}

/**
 * Replays a query, or says why it can't. Its own queries to Postgres read
 * pages through shared buffers too (pageinspect, and fetching rows by ctid),
 * so the caller puts the cache back afterwards (restoreCache, step 9 in
 * ARCHITECTURE.md).
 */
export async function replayQuery(db: PGliteInterface, input: ReplayInput): Promise<Replay> {
  const { plan, relations } = input
  const root = plan.root
  const missing = allNodes(root).find((node) => !REPLAYABLE.has(node.nodeType))
  if (missing) return { status: 'unsupported', reason: `Animation isn’t available yet for ${missing.nodeType}.` }
  const shape = unsupportedShape(root)
  if (shape !== null) return { status: 'unsupported', reason: shape }
  const above = nodesAbove(root)
  for (const node of above) {
    const reason = node.nodeType === 'Sort' ? unsupportedSort(node) : null
    if (reason !== null) return { status: 'unsupported', reason }
  }

  try {
    const limits = await limitSettings(db, input.sql, above)
    const replayer = new PlanReplayer(db, relations, input.prepared, root, limits)
    const play = await replayer.build(root, null)
    const buffers = new SharedBuffers(input.cacheBefore, relations)
    const events = numberResultRows([...play(buffers)], root.id)
    const heapPages: HeapPageContents[] = []
    for (const table of replayer.tables.values()) heapPages.push(...(await readHeapInternals(db, table, events)))
    const trace: Trace = {
      relations: relations.map((relation) => ({
        id: relation.oid,
        name: relation.name,
        kind: relation.kind,
        pages: relation.pages,
      })),
      events,
      indexPages: replayer.indexPages,
      sorts: replayer.sorts,
      limits: [...limits].map(([node, { offset, count }]) => ({ node, offset, count })),
      heapPages,
    }

    const notes = [...replayer.notes]
    let replayedRows: (string | null)[][] | null = null
    // A Sort or Limit at the top can output the sort keys after the result's columns.
    if (root.output.length >= input.columnCount) {
      const output = root.output.slice(0, input.columnCount)
      const rows = emittedRows(trace.events).slice(0, input.resultRows.length)
      // The output expressions name the tables' columns, as the plan prints them.
      replayedRows = await readValues(db, scansOf(root), rows, output)
    } else {
      notes.push('The plan’s output columns don’t line up with the result’s, so values weren’t compared.')
    }

    const validation = validate({
      plan,
      trace,
      resultRows: input.resultRows,
      totalRows: input.totalRows,
      replayedRows,
      notes,
    })
    if (replayer.skipScan && onlyMoreHits(validation)) validation.notes.push(CATALOG_NOTE)
    return { status: 'replayed', trace, validation }
  } catch (error) {
    if (error instanceof Unsupported) return { status: 'unsupported', reason: error.message }
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Builds a plan's trace, node by node, from the scans up: each node's
 * queries to Postgres first (build), then its events, made in the executor's
 * order when the plan plays. Each node is told how many rows its parent will
 * ask it for (`rowsNeeded`, null for all): a Limit asks for only so many,
 * and the nodes below it stop there, as they do in Postgres, where the Limit
 * simply stops asking.
 */
class PlanReplayer {
  /** Every index page the scans read, for the trace, each once. */
  indexPages: IndexPageContents[] = []
  sorts: SortContents[] = []
  notes: string[] = []
  /** Whether an index scan is a skip scan (see CATALOG_NOTE). */
  skipScan = false
  /** Every walk of an index made or used here, by walkKey. */
  walks = new Map<string, WalkedIndex>()
  /** The tables the scans read, by oid, in plan order. */
  tables = new Map<number, Relation>()

  private db: PGliteInterface
  private relations: Relation[]
  /** The walks made before the query ran; null when this is that preparation. */
  private prepared: Prepared | null
  /** Each node's parent, by node id. */
  private parents = new Map<number, PlanNode>()
  private limits: Map<number, LimitSettings>
  private indexPageKeys = new Set<string>()

  constructor(
    db: PGliteInterface,
    relations: Relation[],
    prepared: Prepared | null,
    root: PlanNode,
    limits: Map<number, LimitSettings>,
  ) {
    this.db = db
    this.relations = relations
    this.prepared = prepared
    this.limits = limits
    for (const node of allNodes(root)) for (const child of node.children) this.parents.set(child.id, node)
  }

  /**
   * A node's part of the trace, and its children's. A node whose parent asks
   * it for no rows (under LIMIT 0) never starts.
   */
  async build(node: PlanNode, rowsNeeded: number | null): Promise<Play> {
    if (rowsNeeded === 0) return nothing
    switch (node.nodeType) {
      case 'Limit':
        return this.limit(node, rowsNeeded)
      case 'Sort':
        return this.sort(node, rowsNeeded)
      case 'Nested Loop':
        return this.nestedLoop(node, rowsNeeded)
      case 'Seq Scan':
        return this.seqScan(node, rowsNeeded)
      case 'Index Scan':
      case 'Index Only Scan':
        return this.indexScan(node, rowsNeeded)
      case 'Bitmap Heap Scan':
        return this.bitmapScan(node, rowsNeeded)
    }
    throw new Unsupported(`Animation isn’t available yet for ${node.nodeType}.`)
  }

  private async limit(node: PlanNode, rowsNeeded: number | null): Promise<Play> {
    const settings = this.limits.get(node.id) as LimitSettings
    // LIMIT 0 asks its child for nothing.
    const child = settings.count === 0 ? nothing : await this.build(node.children[0], childRowsNeeded(settings, rowsNeeded))
    return (buffers) => limitEvents(node, child(buffers), settings, rowsNeeded)
  }

  /** A Sort reads all its input before it passes on a row. */
  private async sort(node: PlanNode, rowsNeeded: number | null): Promise<Play> {
    const [childNode] = node.children
    const child = await this.build(childNode, null)
    const [table, ...others] = scansOf(childNode)
    if (others.length > 0) throw new Unsupported('Animation isn’t available yet for a Sort above a join.')
    const input = rowsPassedUp(child, childNode.id).map((row) => row[0])
    const rows = await rankRows(this.db, node, table, input)
    this.sorts.push(sortContents(node, rows))
    const bound = this.sortBound(node)
    return (buffers) => sortEvents(node, [...child(buffers)], rows, bound, rowsNeeded)
  }

  /**
   * The bound a Limit directly above a Sort gives it (ExecSetTupleBound): the
   * rows it will ask for, LIMIT + OFFSET. Null without one.
   */
  private sortBound(sort: PlanNode): number | null {
    const parent = this.parents.get(sort.id)
    const settings = parent?.nodeType === 'Limit' ? this.limits.get(parent.id) : undefined
    if (settings === undefined || settings.count === null) return null
    return settings.count + settings.offset
  }

  /**
   * A Nested Loop: its outer side, then a loop of its inner side for each
   * outer row (nestedLoop.ts). Postgres gives each outer row's values for the
   * inner side's parameters, and checks the Join Filter on each pair.
   */
  private async nestedLoop(node: PlanNode, rowsNeeded: number | null): Promise<Play> {
    if (rowsNeeded !== null) throw new Unsupported('Animation isn’t available yet for a join asked for only some of its rows.')
    const [outerNode, innerNode] = node.children
    const outer = await this.build(outerNode, null)
    const outerRows = rowsPassedUp(outer, outerNode.id)
    const outerTables = scansOf(outerNode)
    const references = subtreeReferences(innerNode, new Set(outerTables.map((table) => table.alias)))
    // Each outer row's values for them, two each: as text to show, and as a constant to put in the inner side's conditions.
    const values = await readValues(
      this.db,
      outerTables,
      outerRows,
      references.flatMap((reference) => [`(${reference})::text`, constantOf(reference)]),
    )
    // An inner side that can match only once per outer row is asked for one row.
    const innerRowsNeeded = node.innerUnique ? 1 : null
    // Loops with the same values do the same work (without parameters, every loop does), so each is built once.
    const plays = new Map<string, Play>()
    const loops: InnerLoop[] = []
    for (const row of values) {
      const constants = new Map(references.map((reference, i) => [reference, row[2 * i + 1] as string]))
      const key = JSON.stringify([...constants.values()])
      let play = plays.get(key)
      if (play === undefined) {
        play = await this.build(bindNode(innerNode, constants), innerRowsNeeded)
        plays.set(key, play)
      }
      loops.push({ play, params: references.map((name, i) => ({ name, value: row[2 * i] })), filter: null })
    }
    if (node.joinFilter !== null) {
      await this.checkJoinFilter(node.joinFilter, outerTables, scansOf(innerNode), outerRows, loops, innerNode.id)
    }
    return (buffers) => nestedLoopEvents(node, outer(buffers), loops, buffers)
  }

  /** Asks Postgres whether each pair of an outer row and a row of its loop passes the Join Filter, in one query. */
  private async checkJoinFilter(
    joinFilter: string,
    outerTables: ScannedTable[],
    innerTables: ScannedTable[],
    outerRows: RowRef[][],
    loops: InnerLoop[],
    innerId: number,
  ) {
    const innerRows = loops.map((loop) => rowsPassedUp(loop.play, innerId))
    const pairs = loops.flatMap((_, i) => innerRows[i].map((inner) => [...outerRows[i], ...inner]))
    const results = await readValues(this.db, [...outerTables, ...innerTables], pairs, [`coalesce(${joinFilter}, false)`])
    let at = 0
    loops.forEach((loop, i) => {
      loop.filter = innerRows[i].map(() => results[at++][0] === 't')
    })
  }

  private async seqScan(node: PlanNode, rowsNeeded: number | null): Promise<Play> {
    const table = this.tableOf(node)
    const pages = await scanPages(this.db, node, table)
    const stop = await seqScanStop(this.db, node, pages, rowsNeeded)
    for (const note of await ringBufferNotes(this.db, table)) if (!this.notes.includes(note)) this.notes.push(note)
    return (buffers) => seqScanEvents(node, table, pages, buffers, stop)
  }

  private async indexScan(node: PlanNode, rowsNeeded: number | null): Promise<Play> {
    const table = this.tableOf(node)
    const index = this.indexOf(node, table)
    const { walk, visibilityMap } = await this.walk(node, node, table, index)
    const { rows, dead } = await fetchIndexScan(this.db, node, table, index, walk)
    return (buffers) => indexScanEvents(node, table, index, walk.steps, rows, dead, visibilityMap, buffers, rowsNeeded)
  }

  /** A Bitmap Heap Scan over one Bitmap Index Scan. */
  private async bitmapScan(node: PlanNode, rowsNeeded: number | null): Promise<Play> {
    if (node.lossyHeapBlocks !== null && node.lossyHeapBlocks > 0) throw new Unsupported(LOSSY_REASON)
    const [indexNode] = node.children
    const table = this.tableOf(node)
    const index = this.indexOf(indexNode, table)
    const { walk } = await this.walk(indexNode, node, table, index)
    const rows = await fetchRows(this.db, node, table, entryTids(walk))
    return (buffers) => bitmapScanEvents(node, indexNode, table, index, walk.steps, rows, buffers, rowsNeeded)
  }

  /** Walks an index scan's index, before the query runs, without replaying the rest (see prepareReplay). */
  async walkOnly(indexNode: PlanNode): Promise<void> {
    // A Bitmap Index Scan names no table: its parent does.
    const tableNode = indexNode.nodeType === 'Bitmap Index Scan' ? (this.parents.get(indexNode.id) as PlanNode) : indexNode
    const table = this.tableOf(tableNode)
    await this.walk(indexNode, tableNode, table, this.indexOf(indexNode, table))
  }

  /**
   * An index scan's walk of its index: the one made before the query ran, if
   * it was for this scan, with these values (EXPLAIN ANALYZE plans again,
   * and could in theory pick another index or node type); otherwise a walk
   * now. Rethrows the error that stopped the walks before the query.
   */
  private async walk(indexNode: PlanNode, tableNode: PlanNode, table: Relation, index: Relation): Promise<WalkedIndex> {
    if (this.prepared?.status === 'error') throw this.prepared.error
    const key = walkKey(indexNode)
    let walked = this.walks.get(key)
    if (walked === undefined) {
      const before = this.prepared?.status === 'walked' ? this.prepared.walks.get(key) : undefined
      walked = before !== undefined && sameScan(before, indexNode) ? before : await walkIndex(this.db, indexNode, tableNode, table, index)
      this.walks.set(key, walked)
    }
    if (walked.walk.skipScan) this.skipScan = true
    for (const page of walked.walk.pages) {
      const pageKey = `${page.relation}/${page.block}`
      if (this.indexPageKeys.has(pageKey)) continue
      this.indexPageKeys.add(pageKey)
      this.indexPages.push(page)
    }
    return walked
  }

  /** The table a scan reads. Throws Unsupported for one not among the query's relations (a temporary table). */
  private tableOf(node: PlanNode): Relation {
    // A table and an index can't share a name in a schema, so the name is enough.
    const table = this.relations.find(
      (relation) => relation.schema === node.relation?.schema && relation.name === node.relation?.name,
    )
    if (!table) {
      throw new Unsupported('Animation isn’t available for temporary tables, which Postgres keeps outside shared buffers.')
    }
    this.tables.set(table.oid, table)
    return table
  }

  /** The index an index scan reads; it lives in its table's schema. */
  private indexOf(node: PlanNode, table: Relation): Relation {
    const index = this.relations.find((relation) => relation.schema === table.schema && relation.name === node.indexName)
    if (!index) throw new Error(`${node.title}: no index ${node.indexName}`)
    return index
  }
}

/** How walks are kept: by the scan node and its Index Cond, with any parameters' values in it. */
function walkKey(node: PlanNode): string {
  return `${node.id} ${node.indexCond}`
}

/** Whether a walk made before the query ran is for this index scan. */
function sameScan(walked: WalkedIndex, node: PlanNode): boolean {
  return (
    walked.walk.indexName === node.indexName &&
    walked.walk.indexCond === node.indexCond &&
    (walked.visibilityMap !== null) === (node.nodeType === 'Index Only Scan')
  )
}

/**
 * Walks an index scan's index, and for an Index Only Scan reads the
 * visibility map too. `tableNode` is the node that reads the table: the
 * index scan itself, or a Bitmap Index Scan's parent.
 */
async function walkIndex(
  db: PGliteInterface,
  indexNode: PlanNode,
  tableNode: PlanNode,
  table: Relation,
  index: Relation,
): Promise<WalkedIndex> {
  if (tableNode.relation === null) throw new Error(`${tableNode.title} names no table`)
  const walk = await walkIndexScan(db, indexNode, index, tableNode.relation.alias)
  const visibilityMap =
    indexNode.nodeType === 'Index Only Scan'
      ? await readVisibilityMap(db, table, entryTids(walk).map((tid) => tid.block))
      : null
  return { walk, visibilityMap }
}

/**
 * The rows a node passes up when it plays, one row per table each (see
 * scansOf). Which rows doesn't depend on what's in shared buffers, so it
 * plays against empty ones, which it doesn't keep.
 */
function rowsPassedUp(play: Play, node: number): RowRef[][] {
  const rows: RowRef[][] = []
  for (const event of play(new SharedBuffers({ pages: [] }, []))) {
    if (event.type === 'row.emit' && event.node === node) rows.push(wholeRow(event))
  }
  return rows
}

/** The rows sent to the result, in result order, one row per table each. */
function emittedRows(events: TraceEvent[]): RowRef[][] {
  const rows: RowRef[][] = []
  for (const event of events) {
    if (event.type === 'row.emit' && event.resultIndex !== null) rows[event.resultIndex] = wholeRow(event)
  }
  return rows
}

/**
 * Each Limit node's LIMIT and OFFSET, read from the plan Postgres makes for
 * the query (limits.ts), by node id. Both list the Limit nodes outermost
 * first. Throws Unsupported for one the replay can't use.
 */
async function limitSettings(db: PGliteInterface, sql: string, above: PlanNode[]): Promise<Map<number, LimitSettings>> {
  const settings = new Map<number, LimitSettings>()
  const limitNodes = above.filter((node) => node.nodeType === 'Limit')
  if (limitNodes.length === 0) return settings
  const readings = await readLimits(db, sql)
  if (readings.length !== limitNodes.length) {
    throw new Error(`Postgres’s plan has ${readings.length} Limit nodes, the plan that ran ${limitNodes.length}.`)
  }
  for (const [i, node] of limitNodes.entries()) {
    const reading = readings[i]
    if (reading.status === 'withTies') throw new Unsupported('Animation isn’t available yet for FETCH FIRST … WITH TIES.')
    if (reading.status === 'notConstant') {
      throw new Unsupported('Animation isn’t available yet for a LIMIT or OFFSET that is only known when the query runs.')
    }
    settings.set(node.id, reading.settings)
  }
  return settings
}

/** The events with the top node's rows numbered as the result's rows, from 0. */
function numberResultRows(events: TraceEvent[], root: number): TraceEvent[] {
  let resultIndex = 0
  return events.map((event) =>
    event.type === 'row.emit' && event.node === root ? { ...event, resultIndex: resultIndex++ } : event,
  )
}

/**
 * Why a bitmap heap scan isn't replayed when its bitmap went lossy: which
 * pages the bitmap keeps whole depends on how its hash table fills up,
 * which the replay doesn't model.
 */
export const LOSSY_REASON =
  'Animation isn’t available yet for lossy bitmaps: this bitmap outgrew work_mem, so for some heap pages it kept only the page, and Postgres rechecked every row on them.'

/**
 * Why a skip scan can count more buffer hits than its replay: the first
 * skip scan over a type in a session looks up in the system catalogs how to
 * step through its values (an operator class's skip support), and Postgres
 * counts those page accesses as the scan's. Later ones find the answer in
 * memory. The replay reads only the query's own tables and indexes.
 */
export const CATALOG_NOTE =
  'A session’s first skip scan over a column type also reads system catalog pages, to look up how to step through its values. Postgres counts them as the scan’s buffer hits; the replay doesn’t. Run the query again to compare.'

/** Whether the only checks that failed are buffer hits, with Postgres counting more than the replay. */
function onlyMoreHits(validation: Validation) {
  const failed = validation.checks.filter((check) => !check.ok)
  return failed.length > 0 && failed.every((check) => check.label.endsWith(': buffer hits') && check.postgres > check.replay)
}

/** A note if a Seq Scan reads its table through a ring of buffers, which the replay doesn't model. */
async function ringBufferNotes(db: PGliteInterface, table: Relation): Promise<string[]> {
  const ringSize = (await sharedBufferPages(db)) / 4
  if (table.pages <= ringSize) return []
  return [
    `${table.name} has more pages than a quarter of shared buffers (${ringSize.toLocaleString('en-US')}), so Postgres reads it through a small ring of buffers, which the replay doesn't model: buffer counts may not match.`,
  ]
}

/** The size of shared buffers, in pages. */
async function sharedBufferPages(db: PGliteInterface): Promise<number> {
  const result = await query<{ pages: number }>(
    db,
    `SELECT setting::int AS pages FROM pg_settings WHERE name = 'shared_buffers'`,
  )
  return result.rows[0].pages
}
