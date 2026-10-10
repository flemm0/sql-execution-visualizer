import type { PGliteInterface } from '@electric-sql/pglite'
import type { CacheSnapshot, Relation } from '../db/inspector'
import type { Plan, PlanNode } from '../db/plan'
import { query, queryText } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import { SharedBuffers } from './buffers'
import { replayIndexScan, walkIndexScan, type IndexWalk } from './indexScan'
import { scanPages, seqScanEvents } from './seqScan'
import type { RowRef, Trace, TraceEvent } from './trace'
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
 * index, or the error that stopped it (Unsupported, for one), to report with
 * the replay.
 */
export type Prepared = { status: 'walked'; walk: IndexWalk } | { status: 'error'; error: unknown }

/** Node types the replay engine can replay. */
const REPLAYABLE = new Set(['Seq Scan', 'Index Scan'])

/**
 * The part of a replay that has to happen before the query runs (in the
 * order of ARCHITECTURE.md, after the cache snapshot and before execution).
 * Running an index scan can change its index: it marks entries whose rows
 * nobody can see any more as dead, and later scans skip them. So an index
 * scan's index is walked first, as the query will find it. `plan` comes from
 * a plain EXPLAIN (VERBOSE). Reading the pages loads them into shared
 * buffers, so the caller evicts them again before running the query.
 *
 * Returns null when there's nothing to do before the query runs.
 */
export async function prepareReplay(db: PGliteInterface, plan: Plan, relations: Relation[]): Promise<Prepared | null> {
  const root = plan.root
  if (root.nodeType !== 'Index Scan' || root.children.length > 0) return null
  const found = scanRelations(root, relations)
  if (found === null || found.index === null) return null
  try {
    return { status: 'walked', walk: await walkIndexScan(db, root, found.index) }
  } catch (error) {
    return { status: 'error', error }
  }
}

/** The table a scan reads, and the index it reads it through; null for a table not among the relations (a temporary table). */
function scanRelations(node: PlanNode, relations: Relation[]): { table: Relation; index: Relation | null } | null {
  // A table and an index can't share a name in a schema, so the name is enough.
  const table = relations.find(
    (relation) => relation.schema === node.relation?.schema && relation.name === node.relation?.name,
  )
  if (!table) return null
  // An index lives in its table's schema.
  const index = relations.find((relation) => relation.schema === table.schema && relation.name === node.indexName)
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
  // A scan with children runs a subquery for a condition (an InitPlan or SubPlan).
  if (root.children.length > 0) return { status: 'unsupported', reason: 'Animation isn’t available yet for subqueries.' }
  const found = scanRelations(root, relations)
  if (found === null) {
    return {
      status: 'unsupported',
      reason: 'Animation isn’t available for temporary tables, which Postgres keeps outside shared buffers.',
    }
  }

  const { table, index } = found

  try {
    const buffers = new SharedBuffers(input.cacheBefore, relations)
    let events: TraceEvent[]
    const notes: string[] = []
    if (root.nodeType === 'Index Scan') {
      if (index === null) throw new Error(`${root.title}: no index ${root.indexName}`)
      events = await replayIndexScan(db, root, table, index, await indexWalk(db, root, index, input.prepared), buffers)
    } else {
      events = [...seqScanEvents(root, table, await scanPages(db, root, table), buffers)]
      notes.push(...(await ringBufferNotes(db, table)))
    }
    const trace: Trace = {
      relations: relations.map((relation) => ({
        id: relation.oid,
        name: relation.name,
        kind: relation.kind,
        pages: relation.pages,
      })),
      events,
    }

    let replayedRows: (string | null)[][] | null = null
    if (root.output.length === input.columnCount) {
      replayedRows = await readRows(db, root, emittedRows(trace.events).slice(0, input.resultRows.length))
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
    return { status: 'replayed', trace, validation }
  } catch (error) {
    if (error instanceof Unsupported) return { status: 'unsupported', reason: error.message }
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The index scan's walk from before the query ran, if it was for the plan
 * that ran (EXPLAIN ANALYZE plans again, and could in theory pick another
 * index); otherwise a walk now. Rethrows the error that stopped it.
 */
async function indexWalk(db: PGliteInterface, node: PlanNode, index: Relation, prepared: Prepared | null) {
  if (prepared?.status === 'error') throw prepared.error
  if (prepared?.status === 'walked' && prepared.walk.indexName === node.indexName && prepared.walk.indexCond === node.indexCond) {
    return prepared.walk
  }
  return walkIndexScan(db, node, index)
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
 * Reads the values a scan node outputs for the given rows of its table, by
 * ctid, in the order given, as Postgres's text (as the results pane shows them).
 */
async function readRows(db: PGliteInterface, node: PlanNode, rows: RowRef[]): Promise<(string | null)[][]> {
  if (rows.length === 0 || node.relation === null) return []
  const { schema, name, alias } = node.relation
  const ctids = rows.map((row) => `'(${row.block},${row.offset})'`).join(', ')
  // The output expressions name the table's columns, as the plan prints them.
  return queryText(
    db,
    `SELECT ${node.output.join(', ')}
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
