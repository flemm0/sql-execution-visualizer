import type { Trace, TraceEvent } from '../replay/trace'
import { collapseStretch, expandStretch, isStretch, type Step } from './condense'

/*
 * Jump-to-next controls (docs/UX.md#playback, ADR 0043): move the player
 * forward to the next event of a kind, searching the trace from the events
 * done. The player lands on the step holding that event alone, expanding the
 * stretch it's in when it's in one, so the caption is that event's, and
 * collapsing an expanded stretch the jump leaves.
 */

/** What a jump-to-next control looks for. */
export type JumpTarget = 'row' | 'page' | 'node'

/** Whether an event is one a jump to `target` stops at. */
export function isJumpTarget(event: TraceEvent, target: JumpTarget): boolean {
  switch (target) {
    // A row sent to the result (not a row passed up to a parent node).
    case 'row':
      return event.type === 'row.emit' && event.resultIndex !== null
    // A page asked for in shared buffers, found there or read from disk; not a
    // page read ahead that the scan never got to.
    case 'page':
      return (event.type === 'buffer.hit' || event.type === 'buffer.read') && event.ahead !== true
    // A plan node starting or finishing, or a Limit stopping the nodes below it.
    case 'node':
      return event.type === 'node.start' || event.type === 'node.finish' || event.type === 'limit.stop'
  }
}

/** The index of the first event at or after `from` that a jump to `target` stops at, or null if there's none. */
export function nextEvent(trace: Trace, from: number, target: JumpTarget): number | null {
  for (let i = Math.max(0, from); i < trace.events.length; i++) {
    if (isJumpTarget(trace.events[i], target)) return i
  }
  return null
}

/**
 * The steps and position that show event `index` alone, jumping from
 * `position`: the position is the number of steps done once that event has
 * happened. A stretch holding the event is expanded. Leaving an expanded
 * stretch for an event outside it collapses it again, so jumping along a long
 * trace doesn't leave a trail of expanded stretches; any other stretch
 * expanded stays as it is.
 */
export function landOnEvent(steps: Step[], position: number, index: number): { steps: Step[]; position: number } {
  const leaving = position > 0 ? steps[position - 1]?.stretch : undefined
  if (leaving !== undefined && (index < leaving.start || index >= leaving.end)) {
    steps = collapseStretch(steps, position - 1).steps
  }
  const at = steps.findIndex((step) => step.start <= index && index < step.end)
  if (at === -1) return { steps, position: steps.length }
  if (!isStretch(steps[at])) return { steps, position: at + 1 }
  // Expanded, the stretch's events are one step each, starting at `at`.
  return { steps: expandStretch(steps, at), position: at + 1 + (index - steps[at].start) }
}
