import type { PGliteInterface } from '@electric-sql/pglite'
import type { PlanNode, ScannedTable } from '../db/plan'
import { queryText } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import type { RowRef, SortContents, SortRow, TraceEvent } from './trace'
import { Tuplesort } from './tuplesort'
import { Unsupported } from './unsupported'

/*
 * Replays a Sort node (nodeSort.c). The first time its parent asks it for a
 * row, it asks its child for every row there is, holding them in memory,
 * then sorts them, and only then passes them on, in order. Rows that tie on
 * every sort key come out in the order Postgres's own sort leaves them in
 * (tuplesort.ts).
 *
 * With a Limit directly above it, the Sort knows how many rows it will be
 * asked for (the bound: LIMIT + OFFSET), and once it holds more than twice
 * that many it keeps only the best ones (a top-N heapsort): each new row
 * either takes the place of the worst kept, or is dropped.
 *
 * Postgres compares the rows: one query ranks them all by the plan's own sort
 * keys, and writes each key's value as text for the visualization.
 */

/**
 * Ranks the rows a Sort is given, by its sort keys, and reads their keys'
 * values: one SortRow for each, in the order given. Rows that tie on every
 * key share a rank. `table` is the table the scan below the Sort reads, by
 * the name its sort keys use.
 */
export async function rankRows(db: PGliteInterface, node: PlanNode, table: ScannedTable, rows: RowRef[]): Promise<SortRow[]> {
  if (rows.length === 0) return []
  const { schema, name, alias } = table
  const ctids = rows.map((row) => `'(${row.block},${row.offset})'`).join(', ')
  // Each sort key is written as it could appear in ORDER BY ("orders.total DESC"), over the scan's table.
  const keys = node.sortKeys.map((key, i) => `(${sortKeyExpression(key)})::text AS replay_key${i}`)
  const result = await queryText(
    db,
    `SELECT dense_rank() OVER (ORDER BY ${node.sortKeys.join(', ')}) AS replay_rank${keys.map((key) => `, ${key}`).join('')}
     FROM unnest(ARRAY[${ctids}]::tid[]) WITH ORDINALITY AS replay_wanted(replay_tid, replay_position)
     JOIN ONLY ${quoteIdentifier(schema)}.${quoteIdentifier(name)} AS ${quoteIdentifier(alias)}
       ON ${quoteIdentifier(alias)}.ctid = replay_wanted.replay_tid
     ORDER BY replay_wanted.replay_position`,
  )
  if (result.length !== rows.length) throw new Error(`${node.title}: ${rows.length} rows to rank, but Postgres found ${result.length}.`)
  return result.map(([rank, ...key], i) => ({ row: rows[i], key, rank: Number(rank) }))
}

/** A sort key's expression without its ordering: "orders.total DESC NULLS LAST" gives "orders.total". */
export function sortKeyExpression(key: string): string {
  return key
    .replace(/ NULLS (FIRST|LAST)$/, '')
    .replace(/ DESC$/, '')
    .replace(/ USING \S+$/, '')
}

/**
 * Why a Sort can't be replayed, or null if it can: a sort that outgrew
 * work_mem and spilled to disk isn't replayed yet.
 */
export function unsupportedSort(node: PlanNode): string | null {
  if (node.sortMethod === 'quicksort' || node.sortMethod === 'top-N heapsort') return null
  return `Animation isn’t available yet for sorts that spill to disk (${node.sortMethod ?? 'unknown'}): this one outgrew work_mem.`
}

/**
 * The trace of a Sort: its child's events, as the Sort asks for every row
 * (`childEvents`, all of them: a Sort always reads its input to the end),
 * with what the Sort does with each row, then the sort, then its rows passed
 * on in order. `bound` is the Limit's LIMIT + OFFSET above it, if any;
 * `rowsNeeded`, the most rows its parent will ask for (null for all): the
 * Sort is stopped after that many, and doesn't finish.
 */
export function* sortEvents(
  node: PlanNode,
  childEvents: TraceEvent[],
  rows: SortRow[],
  bound: number | null,
  rowsNeeded: number | null,
): Generator<TraceEvent> {
  const child = node.children[0]
  const ranks = new Map(rows.map((row) => [rowKey(row.row), row.rank]))
  const rank = (row: RowRef) => ranks.get(rowKey(row)) as number
  const sort = new Tuplesort<RowRef>((a, b) => rank(a) - rank(b), bound)

  yield { type: 'node.start', node: node.id }
  for (const event of childEvents) {
    yield event
    if (event.type !== 'row.emit' || event.node !== child.id) continue
    const result = sort.put(event.row)
    if (result.kind === 'switched') yield { type: 'sort.heap', node: node.id, kept: result.kept, dropped: result.dropped }
    else if (result.kind === 'kept') yield { type: 'sort.keep', node: node.id, row: event.row, replaced: result.replaced }
    else if (result.kind === 'discarded') yield { type: 'sort.discard', node: node.id, row: event.row }
  }

  const sorted = sort.sorted()
  const method = sort.usedBound ? 'top-N heapsort' : 'quicksort'
  // Postgres switches to a top-N heapsort early when memory runs out first, which the replay doesn't model.
  if (method !== node.sortMethod) {
    throw new Unsupported(
      `Animation isn’t available yet for this sort: Postgres used a ${node.sortMethod}, where the replay would use a ${method} (it switches early when it runs out of work_mem).`,
    )
  }
  yield { type: 'sort.done', node: node.id, rows: sorted.length, method }
  for (const [i, row] of sorted.entries()) {
    // Stopped: its parent has all the rows it wants.
    if (rowsNeeded !== null && i >= rowsNeeded) return
    yield { type: 'row.emit', node: node.id, row, resultIndex: null }
  }
  if (rowsNeeded !== null && sorted.length >= rowsNeeded) return
  yield { type: 'node.finish', node: node.id }
}

/** A Sort's contents for the trace. */
export function sortContents(node: PlanNode, rows: SortRow[]): SortContents {
  return { node: node.id, keys: node.sortKeys, rows }
}

function rowKey(row: RowRef) {
  return `${row.relation}/${row.block}/${row.offset}`
}
