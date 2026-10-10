import type { PGliteInterface } from '@electric-sql/pglite'
import type { CacheSnapshot, Relation } from '../db/inspector'
import type { Plan, PlanNode } from '../db/plan'
import { query, queryText } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import { SharedBuffers } from './buffers'
import { scanPages, seqScanEvents } from './seqScan'
import type { RowRef, Trace, TraceEvent } from './trace'
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
}

/** Node types the replay engine can replay. */
const REPLAYABLE = new Set(['Seq Scan'])

/**
 * Replays a query, or says why it can't. Its own queries to Postgres read
 * only pages the query itself read, so the cache stays as the query left it.
 * (Replaying index scans will read B-tree pages with pageinspect; that will
 * need restoreCache afterwards, step 9 in ARCHITECTURE.md.)
 */
export async function replayQuery(db: PGliteInterface, input: ReplayInput): Promise<Replay> {
  const { plan, relations } = input
  const root = plan.root
  const missing = allNodes(root).find((node) => !REPLAYABLE.has(node.nodeType))
  if (missing) return { status: 'unsupported', reason: `Animation isn’t available yet for ${missing.nodeType}.` }
  // A Seq Scan with children runs a subquery for its Filter (an InitPlan or SubPlan).
  if (root.children.length > 0) return { status: 'unsupported', reason: 'Animation isn’t available yet for subqueries.' }
  // A table and an index can't share a name in a schema, so the name is enough.
  const table = relations.find(
    (relation) => relation.schema === root.relation?.schema && relation.name === root.relation?.name,
  )
  if (!table) {
    return {
      status: 'unsupported',
      reason: 'Animation isn’t available for temporary tables, which Postgres keeps outside shared buffers.',
    }
  }

  try {
    const pages = await scanPages(db, root, table)
    const buffers = new SharedBuffers(input.cacheBefore, relations)
    const trace: Trace = {
      relations: relations.map((relation) => ({
        id: relation.oid,
        name: relation.name,
        kind: relation.kind,
        pages: relation.pages,
      })),
      events: [...seqScanEvents(root, table, pages, buffers)],
    }

    const notes: string[] = []
    const ringSize = (await sharedBufferPages(db)) / 4
    if (table.pages > ringSize) {
      notes.push(
        `${table.name} has more pages than a quarter of shared buffers (${ringSize.toLocaleString('en-US')}), so Postgres reads it through a small ring of buffers, which the replay doesn't model: buffer counts may not match.`,
      )
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
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
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

/** The size of shared buffers, in pages. */
async function sharedBufferPages(db: PGliteInterface): Promise<number> {
  const result = await query<{ pages: number }>(
    db,
    `SELECT setting::int AS pages FROM pg_settings WHERE name = 'shared_buffers'`,
  )
  return result.rows[0].pages
}
