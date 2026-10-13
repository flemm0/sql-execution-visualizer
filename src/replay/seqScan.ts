import type { PGliteInterface } from '@electric-sql/pglite'
import type { Relation } from '../db/inspector'
import type { PlanNode } from '../db/plan'
import { query } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import type { SharedBuffers } from './buffers'
import { unusedReadAheadEvents } from './readStream'
import type { TraceEvent } from './trace'

/*
 * Replays a Seq Scan, which reads every page of its table in order, from
 * page 0 to the last, and on each page checks every row the query can see
 * against its Filter. The rows that pass go up in that order.
 *
 * Under a Limit it stops as soon as it has passed up the rows the Limit
 * needs, part way through a page: the Filter was checked only on the rows
 * up to there. By then it has asked for pages ahead that it won't use
 * (readStream.ts).
 */

/** What a Seq Scan finds on one page, as Postgres reports it. */
export interface ScannedPage {
  block: number
  /** Rows on the page the query can see. */
  visibleRows: number
  /** Line pointer numbers of the visible rows that pass the Filter, in order. */
  matched: number[]
}

/**
 * Asks Postgres, in one query, what the scan finds on each page of its table:
 * how many rows are visible, and which of them pass the Filter. Postgres
 * evaluates the Filter itself, as the plan deparses it, so the replay never
 * re-implements SQL. Pages with no visible rows are included, with none.
 */
export async function scanPages(db: PGliteInterface, node: PlanNode, table: Relation): Promise<ScannedPage[]> {
  if (node.relation === null) throw new Error(`${node.title} names no table`)
  const { schema, name, alias } = node.relation
  // The block number and line pointer number of a ctid "(12,3)", read as a point.
  const block = '(ctid::text::point)[0]::int'
  const offset = '(ctid::text::point)[1]::int'
  // ONLY: the plan's Seq Scan reads this table alone, not tables that inherit from it.
  const result = await query<{ block: number; visible: number; matched: number[] }>(
    db,
    `SELECT ${block} AS block, count(*)::int AS visible,
       coalesce(json_agg(${offset} ORDER BY ctid) FILTER (WHERE ${node.filter ?? 'true'}), '[]') AS matched
     FROM ONLY ${quoteIdentifier(schema)}.${quoteIdentifier(name)} AS ${quoteIdentifier(alias)}
     GROUP BY 1`,
  )
  const found = new Map(result.rows.map((row) => [row.block, row]))
  return Array.from({ length: table.pages }, (_, block) => {
    const row = found.get(block)
    return { block, visibleRows: row?.visible ?? 0, matched: row?.matched ?? [] }
  })
}

/** Where a Seq Scan stops when its parent needs only some of its rows (a Limit). */
export interface SeqScanStop {
  /** The page it stops on. */
  block: number
  /** The line pointer number of the last row it passes up. */
  offset: number
  /** The visible rows on that page up to that row: the ones the Filter was checked on. */
  checkedRows: number
}

/**
 * Where a Seq Scan stops when its parent will ask for at most `rowsNeeded`
 * rows (null for all), or null if it reads to the end: fewer rows match.
 * Asks Postgres how many rows on the last page the scan got to.
 */
export async function seqScanStop(
  db: PGliteInterface,
  node: PlanNode,
  pages: ScannedPage[],
  rowsNeeded: number | null,
): Promise<SeqScanStop | null> {
  if (rowsNeeded === null || node.relation === null) return null
  const { schema, name, alias } = node.relation
  let left = rowsNeeded
  for (const page of pages) {
    if (page.matched.length < left) {
      left -= page.matched.length
      continue
    }
    const offset = page.matched[left - 1]
    // A TID range scan of the page, up to that row: the rows on it this query can see.
    const result = await query<{ rows: number }>(
      db,
      `SELECT count(*)::int AS rows FROM ONLY ${quoteIdentifier(schema)}.${quoteIdentifier(name)} AS ${quoteIdentifier(alias)}
       WHERE ${quoteIdentifier(alias)}.ctid >= '(${page.block},0)'::tid AND ${quoteIdentifier(alias)}.ctid <= '(${page.block},${offset})'::tid`,
    )
    return { block: page.block, offset, checkedRows: result.rows[0].rows }
  }
  return null
}

/**
 * The trace of a Seq Scan: each page requested (a hit or a read), what was
 * found on it, and the matching rows passed up. With a `stop`, it ends on
 * that page, after that row, and doesn't finish; then come the pages it
 * asked for ahead and won't use.
 */
export function* seqScanEvents(
  node: PlanNode,
  table: Relation,
  pages: ScannedPage[],
  buffers: SharedBuffers,
  stop: SeqScanStop | null = null,
): Generator<TraceEvent> {
  yield { type: 'node.start', node: node.id }
  const blocks = pages.map((page) => page.block)
  const cachedAtStart = blocks.map((block) => buffers.has({ relation: table.oid, block }))
  for (const [position, page] of pages.entries()) {
    const ref = { relation: table.oid, block: page.block }
    yield { type: buffers.access(ref), node: node.id, page: ref }
    if (stop !== null && page.block === stop.block) {
      const matched = page.matched.filter((offset) => offset <= stop.offset)
      yield {
        type: 'heap.page',
        node: node.id,
        page: ref,
        visibleRows: page.visibleRows,
        checkedRows: stop.checkedRows,
        matchedRows: matched.length,
      }
      for (const offset of matched) yield emit(node, table, page.block, offset)
      yield* unusedReadAheadEvents(node.id, table.oid, blocks, cachedAtStart, position + 1, buffers)
      return
    }
    yield {
      type: 'heap.page',
      node: node.id,
      page: ref,
      visibleRows: page.visibleRows,
      matchedRows: page.matched.length,
    }
    for (const offset of page.matched) yield emit(node, table, page.block, offset)
  }
  yield { type: 'node.finish', node: node.id }
}

/** A row passed up; replay.ts numbers the top node's rows for the result. */
function emit(node: PlanNode, table: Relation, block: number, offset: number): TraceEvent {
  return { type: 'row.emit', node: node.id, row: { relation: table.oid, block, offset }, resultIndex: null }
}
