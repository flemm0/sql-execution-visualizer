import type { PGliteInterface } from '@electric-sql/pglite'
import type { Relation } from '../db/inspector'
import type { PlanNode } from '../db/plan'
import { query } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import type { SharedBuffers } from './buffers'
import type { TraceEvent } from './trace'

/*
 * Replays a Seq Scan, which reads every page of its table in order, from
 * page 0 to the last, and on each page checks every row the query can see
 * against its Filter. The rows that pass go to the result in that order.
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

/**
 * The trace of a Seq Scan at the top of the plan: each page requested (a hit
 * or a read), what was found on it, and the matching rows sent to the result.
 */
export function* seqScanEvents(
  node: PlanNode,
  table: Relation,
  pages: ScannedPage[],
  buffers: SharedBuffers,
): Generator<TraceEvent> {
  yield { type: 'node.start', node: node.id }
  let resultIndex = 0
  for (const page of pages) {
    const ref = { relation: table.oid, block: page.block }
    yield { type: buffers.access(ref), node: node.id, page: ref }
    yield {
      type: 'heap.page',
      node: node.id,
      page: ref,
      visibleRows: page.visibleRows,
      matchedRows: page.matched.length,
    }
    for (const offset of page.matched) {
      yield {
        type: 'row.emit',
        node: node.id,
        row: { relation: table.oid, block: page.block, offset },
        resultIndex: resultIndex++,
      }
    }
  }
  yield { type: 'node.finish', node: node.id }
}
