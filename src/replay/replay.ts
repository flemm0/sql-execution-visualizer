import type { PGliteInterface } from '@electric-sql/pglite'
import { readVisibilityMap, type CacheSnapshot, type Relation, type VisibilityMap } from '../db/inspector'
import type { Plan, PlanNode, ScannedTable } from '../db/plan'
import { query, queryText } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import { replayBitmapScan } from './bitmapScan'
import { SharedBuffers } from './buffers'
import { readHeapInternals } from './heapInternals'
import { entryTids, replayIndexScan, walkIndexScan, type IndexWalk } from './indexScan'
import { childRowsNeeded, limitEvents } from './limit'
import { readLimits, type LimitSettings } from './limits'
import { scanPages, seqScanEvents, seqScanStop } from './seqScan'
import { rankRows, sortContents, sortEvents, unsupportedSort } from './sort'
import type { IndexPageContents, RowRef, SortContents, Trace, TraceEvent } from './trace'
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
 * What the replay found before the query ran: an index scan's walk of its
 * index (and for an Index Only Scan, the table's visibility map, null for
 * other index scans), or the error that stopped it (Unsupported, for one), to
 * report with the replay.
 */
export type Prepared = WalkedIndex | { status: 'error'; error: unknown }

export interface WalkedIndex {
  status: 'walked'
  walk: IndexWalk
  visibilityMap: VisibilityMap | null
}

/** Node types the replay engine can replay. */
export const REPLAYABLE = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Bitmap Index Scan', 'Sort', 'Limit'])

/** Node types that read a B-tree index and fetch the rows its entries point at. */
const INDEX_SCANS = new Set(['Index Scan', 'Index Only Scan'])

/**
 * The plan shapes the replay engine can replay: Limit and Sort nodes, each
 * over one child, above one scan, or a Bitmap Heap Scan reading the bitmap
 * of one Bitmap Index Scan. `above` holds the Limit and Sort nodes, from the
 * top down; `tableScan` is the node that reads the table, and `indexScan`
 * the one that reads an index (the same node for an index scan; null for a
 * Seq Scan). Null for any other shape: a node with more children runs a
 * subquery (an InitPlan or SubPlan).
 */
interface PlanShape {
  above: PlanNode[]
  tableScan: PlanNode
  indexScan: PlanNode | null
}

function planShape(root: PlanNode): PlanShape | null {
  const above: PlanNode[] = []
  let node = root
  while (node.nodeType === 'Limit' || node.nodeType === 'Sort') {
    if (node.children.length !== 1) return null
    above.push(node)
    node = node.children[0]
  }
  if (node.nodeType === 'Bitmap Heap Scan') {
    const [child] = node.children
    const single = node.children.length === 1 && child.nodeType === 'Bitmap Index Scan' && child.children.length === 0
    return single ? { above, tableScan: node, indexScan: child } : null
  }
  if (node.children.length > 0) return null
  return { above, tableScan: node, indexScan: INDEX_SCANS.has(node.nodeType) ? node : null }
}

/**
 * The part of a replay that has to happen before the query runs (in the
 * order of ARCHITECTURE.md, after the cache snapshot and before execution).
 * Running an index scan can change its index: it marks entries whose rows
 * nobody can see any more as dead, and later scans skip them. So an index
 * scan's index is walked first, as the query will find it; a Bitmap Index
 * Scan's too, though it marks nothing dead, so every replay sees its index
 * the same way. An Index Only Scan also reads the visibility map bits of the
 * heap pages its entries point into, as the query will find them. `plan`
 * comes from a plain EXPLAIN (VERBOSE). Reading the pages loads them into
 * shared buffers, so the caller evicts them again before running the query.
 *
 * Returns null when there's nothing to do before the query runs.
 */
export async function prepareReplay(db: PGliteInterface, plan: Plan, relations: Relation[]): Promise<Prepared | null> {
  const scans = planShape(plan.root)
  if (scans === null || scans.indexScan === null) return null
  const found = scanRelations(scans.tableScan, scans.indexScan, relations)
  if (found === null || found.index === null) return null
  try {
    return await walkIndex(db, scans.indexScan, scans.tableScan, found.table, found.index)
  } catch (error) {
    return { status: 'error', error }
  }
}

/**
 * Walks an index scan's index, and for an Index Only Scan reads the
 * visibility map too. `tableScan` is the node that reads the table: the
 * index scan itself, or a Bitmap Index Scan's parent.
 */
async function walkIndex(
  db: PGliteInterface,
  indexScan: PlanNode,
  tableScan: PlanNode,
  table: Relation,
  index: Relation,
): Promise<WalkedIndex> {
  if (tableScan.relation === null) throw new Error(`${tableScan.title} names no table`)
  const walk = await walkIndexScan(db, indexScan, index, tableScan.relation.alias)
  const visibilityMap =
    indexScan.nodeType === 'Index Only Scan'
      ? await readVisibilityMap(db, table, entryTids(walk).map((tid) => tid.block))
      : null
  return { status: 'walked', walk, visibilityMap }
}

/**
 * The table a scan reads, and the index it reads it through (`indexScan`
 * names it; null for a Seq Scan); null for a table not among the relations
 * (a temporary table).
 */
function scanRelations(
  tableScan: PlanNode,
  indexScan: PlanNode | null,
  relations: Relation[],
): { table: Relation; index: Relation | null } | null {
  // A table and an index can't share a name in a schema, so the name is enough.
  const table = relations.find(
    (relation) => relation.schema === tableScan.relation?.schema && relation.name === tableScan.relation?.name,
  )
  if (!table) return null
  // An index lives in its table's schema.
  const index = relations.find((relation) => relation.schema === table.schema && relation.name === indexScan?.indexName)
  return { table, index: index ?? null }
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
  const shape = planShape(root)
  if (shape === null) return { status: 'unsupported', reason: 'Animation isn’t available yet for subqueries.' }
  const found = scanRelations(shape.tableScan, shape.indexScan, relations)
  if (found === null) {
    return {
      status: 'unsupported',
      reason: 'Animation isn’t available for temporary tables, which Postgres keeps outside shared buffers.',
    }
  }
  for (const node of shape.above) {
    const reason = node.nodeType === 'Sort' ? unsupportedSort(node) : null
    if (reason !== null) return { status: 'unsupported', reason }
  }

  try {
    const limits = await limitSettings(db, input.sql, shape.above)
    const replayer = new PlanReplayer(db, input, shape, found.table, found.index, limits)
    const events = numberResultRows([...(await replayer.events(root, null))], root.id)
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
      heapPages: await readHeapInternals(db, found.table, events),
    }

    const notes = [...replayer.notes]
    let replayedRows: (string | null)[][] | null = null
    // A Sort or Limit at the top can output the sort keys after the result's columns.
    if (root.output.length >= input.columnCount && shape.tableScan.relation !== null) {
      const output = root.output.slice(0, input.columnCount)
      const rows = emittedRows(trace.events).slice(0, input.resultRows.length)
      replayedRows = await readRows(db, shape.tableScan.relation, output, rows)
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
 * Builds a plan's trace, node by node, from the scan up. Each node is told
 * how many rows its parent will ask it for (`rowsNeeded`, null for all): a
 * Limit asks for only so many, and the nodes below it stop there, as they do
 * in Postgres, where the Limit simply stops asking.
 */
class PlanReplayer {
  /** Every index page the scan read, for the trace. */
  indexPages: IndexPageContents[] = []
  sorts: SortContents[] = []
  notes: string[] = []
  /** Whether the index scan is a skip scan (see CATALOG_NOTE). */
  skipScan = false

  private db: PGliteInterface
  private input: ReplayInput
  private shape: PlanShape
  private table: Relation
  private index: Relation | null
  private limits: Map<number, LimitSettings>
  private buffers: SharedBuffers

  constructor(
    db: PGliteInterface,
    input: ReplayInput,
    shape: PlanShape,
    table: Relation,
    index: Relation | null,
    limits: Map<number, LimitSettings>,
  ) {
    this.db = db
    this.input = input
    this.shape = shape
    this.table = table
    this.index = index
    this.limits = limits
    this.buffers = new SharedBuffers(input.cacheBefore, input.relations)
  }

  /**
   * A node's events, and its children's, in the executor's order. A node
   * whose parent asks it for no rows (under LIMIT 0) never starts.
   */
  async events(node: PlanNode, rowsNeeded: number | null): Promise<Iterable<TraceEvent>> {
    if (rowsNeeded === 0) return []
    if (node.nodeType === 'Limit') {
      const settings = this.limits.get(node.id) as LimitSettings
      // LIMIT 0 asks its child for nothing.
      const child = settings.count === 0 ? [] : await this.events(node.children[0], childRowsNeeded(settings, rowsNeeded))
      return limitEvents(node, child, settings, rowsNeeded)
    }
    if (node.nodeType === 'Sort') {
      // A Sort reads all its input before it passes on a row.
      const childEvents = [...(await this.events(node.children[0], null))]
      const child = node.children[0].id
      const input = childEvents.flatMap((event) => (event.type === 'row.emit' && event.node === child ? [event.row] : []))
      const table = this.shape.tableScan.relation
      if (table === null) throw new Error(`${this.shape.tableScan.title} names no table`)
      const rows = await rankRows(this.db, node, table, input)
      this.sorts.push(sortContents(node, rows))
      return sortEvents(node, childEvents, rows, this.sortBound(node), rowsNeeded)
    }
    return this.scanEvents(rowsNeeded)
  }

  /**
   * The bound a Limit directly above a Sort gives it (ExecSetTupleBound): the
   * rows it will ask for, LIMIT + OFFSET. Null without one.
   */
  private sortBound(sort: PlanNode): number | null {
    const parent = this.shape.above.find((node) => node.children[0] === sort)
    const settings = parent?.nodeType === 'Limit' ? this.limits.get(parent.id) : undefined
    if (settings === undefined || settings.count === null) return null
    return settings.count + settings.offset
  }

  /** The scan's events: a Seq Scan, an index scan, or a bitmap scan. */
  private async scanEvents(rowsNeeded: number | null): Promise<TraceEvent[]> {
    const { tableScan, indexScan } = this.shape
    const { db, table, index, buffers } = this
    if (indexScan === null) {
      const pages = await scanPages(db, tableScan, table)
      const stop = await seqScanStop(db, tableScan, pages, rowsNeeded)
      this.notes.push(...(await ringBufferNotes(db, table)))
      return [...seqScanEvents(tableScan, table, pages, buffers, stop)]
    }
    if (index === null) throw new Error(`${indexScan.title}: no index ${indexScan.indexName}`)
    if (tableScan.lossyHeapBlocks !== null && tableScan.lossyHeapBlocks > 0) throw new Unsupported(LOSSY_REASON)
    const { walk, visibilityMap } = await indexWalk(db, indexScan, tableScan, table, index, this.input.prepared)
    this.skipScan = walk.skipScan
    this.indexPages = walk.pages
    return indexScan === tableScan
      ? replayIndexScan(db, tableScan, table, index, walk, visibilityMap, buffers, rowsNeeded)
      : replayBitmapScan(db, tableScan, indexScan, table, index, walk, buffers, rowsNeeded)
  }
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

/**
 * The index scan's walk from before the query ran, if it was for the plan
 * that ran (EXPLAIN ANALYZE plans again, and could in theory pick another
 * index or node type); otherwise a walk now. Rethrows the error that stopped it.
 */
async function indexWalk(
  db: PGliteInterface,
  indexScan: PlanNode,
  tableScan: PlanNode,
  table: Relation,
  index: Relation,
  prepared: Prepared | null,
): Promise<WalkedIndex> {
  if (prepared?.status === 'error') throw prepared.error
  if (
    prepared?.status === 'walked' &&
    prepared.walk.indexName === indexScan.indexName &&
    prepared.walk.indexCond === indexScan.indexCond &&
    (prepared.visibilityMap !== null) === (indexScan.nodeType === 'Index Only Scan')
  ) {
    return prepared
  }
  return walkIndex(db, indexScan, tableScan, table, index)
}

/** The rows sent to the result, in result order. */
function emittedRows(events: TraceEvent[]): RowRef[] {
  const rows: RowRef[] = []
  for (const event of events) {
    if (event.type === 'row.emit' && event.resultIndex !== null) rows[event.resultIndex] = event.row
  }
  return rows
}

/**
 * Reads the values the plan outputs (`output`, expressions over the scanned
 * table) for the given rows of the table, by ctid, in the order given, as
 * Postgres's text (as the results pane shows them).
 */
async function readRows(db: PGliteInterface, table: ScannedTable, output: string[], rows: RowRef[]): Promise<(string | null)[][]> {
  if (rows.length === 0) return []
  const { schema, name, alias } = table
  const ctids = rows.map((row) => `'(${row.block},${row.offset})'`).join(', ')
  // The output expressions name the table's columns, as the plan prints them.
  return queryText(
    db,
    `SELECT ${output.join(', ')}
     FROM unnest(ARRAY[${ctids}]::tid[]) WITH ORDINALITY AS replay_wanted(replay_tid, replay_position)
     JOIN ONLY ${quoteIdentifier(schema)}.${quoteIdentifier(name)} AS ${quoteIdentifier(alias)}
       ON ${quoteIdentifier(alias)}.ctid = replay_wanted.replay_tid
     ORDER BY replay_wanted.replay_position`,
  )
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
