import type { PlanNode } from '../db/plan'
import type { SharedBuffers } from './buffers'
import type { RowRef, TraceEvent } from './trace'

/*
 * Replays a Nested Loop (nodeNestloop.c), for an inner join. It asks its
 * outer side for a row, then runs its inner side for that row from the start
 * (a rescan: one loop), and pairs the row with each row the inner side
 * passes up. When the inner side has no more, it asks the outer side for the
 * next row, and so on until the outer side has no more.
 *
 * The inner side's conditions can use the outer row's values (parameters):
 * "Index Cond: (o.customer_id = c.id)" searches the index again for each
 * customer. Without any, the inner side does the same work in every loop.
 *
 * With a Join Filter, each pair is checked against it, and only the pairs
 * that pass go up. When the planner knows each outer row matches at most one
 * inner row ("Inner Unique"), the join moves on to the next outer row after
 * the first match, without asking the inner side for more.
 *
 * The rows, the parameters and the Join Filter's results all come from
 * Postgres (replay.ts asks); this only puts the events in the executor's order.
 */

/** One loop of the inner side: how to make its events, and what the join knows about it. */
export interface InnerLoop {
  /** The inner side's events for this loop, made as they're asked for. */
  play: (buffers: SharedBuffers) => Iterable<TraceEvent>
  /** The outer row's values the inner side uses, as text (null for NULL). */
  params: { name: string; value: string | null }[]
  /** With a Join Filter, whether each row the inner side passes up in this loop passes it, in order; null without one. */
  filter: boolean[] | null
}

/**
 * The trace of a Nested Loop: the outer side's events as it asks for rows,
 * and after each outer row, a loop of the inner side (join.loop, then the
 * inner side's events), each inner row checked against the Join Filter if
 * there is one (join.filter), and each pair that passes passed up.
 */
export function* nestedLoopEvents(
  node: PlanNode,
  outer: Iterable<TraceEvent>,
  loops: InnerLoop[],
  buffers: SharedBuffers,
): Generator<TraceEvent> {
  const [outerNode, innerNode] = node.children
  yield { type: 'node.start', node: node.id }
  let loop = 0
  for (const event of outer) {
    yield event
    if (event.type !== 'row.emit' || event.node !== outerNode.id) continue
    // The outer row: one row per table, when the outer side is a join itself.
    const outerRow = wholeRow(event)
    const inner = loops[loop]
    loop++
    yield { type: 'join.loop', node: node.id, loop, outer: outerRow, params: inner.params }
    let pair = 0
    for (const innerEvent of inner.play(buffers)) {
      yield innerEvent
      if (innerEvent.type !== 'row.emit' || innerEvent.node !== innerNode.id) continue
      if (inner.filter !== null) {
        const matched = inner.filter[pair]
        pair++
        yield { type: 'join.filter', node: node.id, outer: outerRow, row: innerEvent.row, matched }
        if (!matched) continue
      }
      // The joined row: the outer row's tables, then the inner row's.
      const joined = [...outerRow, ...(innerEvent.outer ?? [])]
      yield { type: 'row.emit', node: node.id, row: innerEvent.row, outer: joined, resultIndex: null }
    }
  }
  yield { type: 'node.finish', node: node.id }
}

/** A row passed up by a node, as one row per table: a joined row's outer rows, then its own. */
export function wholeRow(event: { row: RowRef; outer?: RowRef[] }): RowRef[] {
  return [...(event.outer ?? []), event.row]
}
