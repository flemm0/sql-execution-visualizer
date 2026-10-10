import type { Plan, PlanNode } from '../db/plan'
import type { Trace } from './trace'

/*
 * The validator checks a replay against what Postgres reported: each node's
 * row count, rows removed by its filter, and buffer hits and reads from
 * EXPLAIN ANALYZE, and the rows sent to the result against the real result.
 * The animation plays either way; a failed check is shown as a warning.
 */

/** One comparison between Postgres's number and the replay's. */
export interface Check {
  /** What is compared, e.g. "Seq Scan on order_items: buffer reads". */
  label: string
  postgres: number
  replay: number
  ok: boolean
}

export interface Validation {
  /** Whether every check passed. */
  ok: boolean
  checks: Check[]
  /** What couldn't be checked, or why a check might not match, in a sentence each. */
  notes: string[]
}

export interface ValidationInput {
  plan: Plan
  trace: Trace
  /** The real result's rows as the results pane shows them (the first MAX_DISPLAYED_ROWS at most). */
  resultRows: (string | null)[][]
  /** How many rows the real result has in all. */
  totalRows: number
  /**
   * The values Postgres gives for the rows the replay sends to the result, in
   * order, read from those rows by ctid: one per row of resultRows, or null
   * when they couldn't be read.
   */
  replayedRows: (string | null)[][] | null
  /** Notes from the replay itself, passed on to the validation. */
  notes: string[]
}

export function validate(input: ValidationInput): Validation {
  const { plan, trace, resultRows, totalRows, replayedRows } = input
  const checks: Check[] = []
  const notes = [...input.notes]
  const replayed = new Set(trace.events.filter((event) => event.type === 'node.start').map((event) => event.node))

  for (const node of allNodes(plan.root)) {
    if (!replayed.has(node.id)) continue
    const own = trace.events.filter((event) => event.node === node.id)
    // Postgres counts a node's buffers together with its children's.
    const subtree = new Set(allNodes(node).map((child) => child.id))
    const buffers = trace.events.filter((event) => subtree.has(event.node))

    checks.push(
      check(
        `${node.title}: rows`,
        Math.round(node.actualRows * node.loops),
        own.filter((event) => event.type === 'row.emit').length,
      ),
    )
    if (node.rowsRemovedByFilter !== null) {
      let removed = 0
      for (const event of own) if (event.type === 'heap.page') removed += event.visibleRows - event.matchedRows
      checks.push(check(`${node.title}: rows removed by filter`, Math.round(node.rowsRemovedByFilter * node.loops), removed))
    }
    checks.push(check(`${node.title}: buffer hits`, node.sharedHit, buffers.filter((e) => e.type === 'buffer.hit').length))
    checks.push(check(`${node.title}: buffer reads`, node.sharedRead, buffers.filter((e) => e.type === 'buffer.read').length))
  }

  const emitted = trace.events.filter((event) => event.type === 'row.emit' && event.resultIndex !== null).length
  checks.push(check('Result: rows', totalRows, emitted))
  if (replayedRows === null) {
    notes.push('The values of the rows sent to the result weren’t compared with the real result.')
  } else {
    const same = resultRows.filter((row, i) => sameRow(row, replayedRows[i])).length
    checks.push(check('Result: rows with the same values, in the same order', resultRows.length, same))
    if (resultRows.length < totalRows) {
      notes.push(`Values were compared for the ${resultRows.length.toLocaleString('en-US')} rows shown; the count for all of them.`)
    }
  }

  return { ok: checks.every((each) => each.ok), checks, notes }
}

function check(label: string, postgres: number, replay: number): Check {
  return { label, postgres, replay, ok: postgres === replay }
}

function sameRow(a: (string | null)[], b: (string | null)[] | undefined) {
  return b !== undefined && a.length === b.length && a.every((value, i) => value === b[i])
}

/** A node and everything under it, depth first. */
export function allNodes(node: PlanNode): PlanNode[] {
  return [node, ...node.children.flatMap(allNodes)]
}
