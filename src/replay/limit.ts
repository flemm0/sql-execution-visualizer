import type { PlanNode } from '../db/plan'
import type { LimitSettings } from './limits'
import type { TraceEvent } from './trace'

/*
 * Replays a Limit node (nodeLimit.c). It asks its child for rows one at a
 * time: it skips the first ones (OFFSET), passes the next ones on, and once
 * it has passed on its LIMIT, it stops: it doesn't ask its child for another
 * row, so the nodes below stop where they are, however much more they could
 * have done. That's the point of a LIMIT: a scan under it reads only as far
 * as it must. With LIMIT 0, it asks for nothing at all.
 *
 * The child's replay is told how many rows the Limit will ask for (see
 * rowsNeeded in replay.ts), so it stops there by itself, after the events of
 * being stopped (pages a scan read ahead and won't use).
 */

/**
 * How many rows a Limit asks its child for at most, given how many its own
 * parent will ask it for (`rowsNeeded`, null for all): OFFSET, then as many
 * as it can pass on. Null for all of them.
 */
export function childRowsNeeded(settings: LimitSettings, rowsNeeded: number | null): number | null {
  const own = settings.count === null ? rowsNeeded : rowsNeeded === null ? settings.count : Math.min(settings.count, rowsNeeded)
  return own === null ? null : settings.offset + own
}

/**
 * The trace of a Limit: its child's events as it asks for rows, each row
 * skipped (OFFSET) or passed on, and its stop when it has its LIMIT.
 * `rowsNeeded` is the most rows its own parent will ask it for (null for
 * all): after that many, it's stopped, and doesn't finish.
 */
export function* limitEvents(
  node: PlanNode,
  child: Iterable<TraceEvent>,
  settings: LimitSettings,
  rowsNeeded: number | null,
): Generator<TraceEvent> {
  yield { type: 'node.start', node: node.id }
  if (settings.count === 0) {
    // LIMIT 0: done before asking for anything.
    yield { type: 'limit.stop', node: node.id, stopped: [] }
    yield { type: 'node.finish', node: node.id }
    return
  }

  const childId = node.children[0].id
  /** The nodes below it that have started and not finished. */
  const working = new Set<number>()
  let pulled = 0
  let passed = 0
  let stopped = false
  for (const event of child) {
    yield event
    if (event.type === 'node.start') working.add(event.node)
    if (event.type === 'node.finish') working.delete(event.node)
    if (event.type !== 'row.emit' || event.node !== childId) continue
    pulled++
    if (pulled <= settings.offset) {
      yield { type: 'limit.skip', node: node.id, row: event.row }
      continue
    }
    yield { type: 'row.emit', node: node.id, row: event.row, resultIndex: null }
    passed++
    // Its parent has all it wants, and won't ask again: stopped from above.
    if (rowsNeeded !== null && passed >= rowsNeeded) {
      stopped = true
    } else if (settings.count !== null && passed >= settings.count) {
      // Asked again, it has passed on its LIMIT: it stops instead of asking its child.
      yield { type: 'limit.stop', node: node.id, stopped: [...working] }
    }
  }
  if (!stopped) yield { type: 'node.finish', node: node.id }
}
