import { messages, type PGliteInterface } from '@electric-sql/pglite'
import { query, sendQuery } from '../db/query'

/*
 * A Limit node's LIMIT and OFFSET, as Postgres planned them. EXPLAIN doesn't
 * show them, even with VERBOSE, but Postgres can log the whole plan tree it
 * made (debug_print_plan), and with client_min_messages at LOG the log
 * reaches the client as a notice. The planner has already worked out
 * constant expressions there ("LIMIT 2 + 1" is a constant 3), so the values
 * are Postgres's own.
 */

/** What a Limit node does, from Postgres's plan. */
export interface LimitSettings {
  /** Rows it skips first (OFFSET); 0 without one. */
  offset: number
  /** The most rows it passes on (LIMIT); null without one (LIMIT ALL, or OFFSET alone). */
  count: number | null
}

/**
 * How one Limit node in the plan dump reads: its settings, or why the replay
 * can't use them (a value only known when the query runs, like a parameter or
 * a subquery, or FETCH FIRST ... WITH TIES).
 */
export type LimitReading = { status: 'constant'; settings: LimitSettings } | { status: 'notConstant' } | { status: 'withTies' }

/**
 * Plans `sql` again with debug_print_plan on, and reads the LIMIT and OFFSET
 * of each Limit node in its plan tree, outermost first (depth first, as
 * PlanNode.id numbers them). Puts the settings it changes back as they were.
 */
export async function readLimits(db: PGliteInterface, sql: string): Promise<LimitReading[]> {
  const before = await query<{ print: string; level: string; pretty: string }>(
    db,
    `SELECT current_setting('debug_print_plan') AS print, current_setting('client_min_messages') AS level,
       current_setting('debug_pretty_print') AS pretty`,
  )
  const { print, level, pretty } = before.rows[0]
  await query(db, `SELECT set_config('debug_print_plan', 'on', false), set_config('client_min_messages', 'log', false),
    set_config('debug_pretty_print', 'off', false)`)
  let received: messages.BackendMessage[]
  try {
    received = await sendQuery(db, `EXPLAIN ${sql}`)
  } finally {
    await query(db, `SELECT set_config('debug_print_plan', ${quote(print)}, false),
      set_config('client_min_messages', ${quote(level)}, false), set_config('debug_pretty_print', ${quote(pretty)}, false)`)
  }
  const error = received.find((message) => message instanceof messages.DatabaseError)
  if (error) throw error
  const plan = received.find(
    (message): message is messages.NoticeMessage => message instanceof messages.NoticeMessage && message.message === 'plan:',
  )
  if (plan?.detail === undefined) throw new Error('Postgres didn’t log the plan, so the Limit’s count is unknown.')
  return parseLimits(plan.detail)
}

function quote(text: string) {
  return `'${text.replaceAll("'", "''")}'`
}

/**
 * Reads the Limit nodes of a plan as Postgres writes it out (nodeToString):
 * "{PLANNEDSTMT ... :planTree {LIMIT ... :limitOffset <> :limitCount {CONST
 * ... :constvalue 8 [ 3 0 0 0 0 0 0 0 ]} :limitOption 0 ...} ...}". Only
 * the plan tree's, not its subplans', outermost first: a node is written
 * before the nodes under it. (Their plan_node_id isn't PlanNode.id: when the
 * planner drops a Subquery Scan that does nothing, the plan under it keeps
 * the subquery's numbers.)
 */
export function parseLimits(dump: string): LimitReading[] {
  const tree = ownFields(dump, dump.indexOf('{')).get(':planTree') ?? ''
  const limits: LimitReading[] = []
  // Postgres breaks the dump into lines at spaces, so any whitespace can follow a word.
  for (const found of tree.matchAll(/\{LIMIT\s/g)) {
    const fields = ownFields(tree, found.index)
    const offset = constantValue(fields.get(':limitOffset') ?? '<>')
    const count = constantValue(fields.get(':limitCount') ?? '<>')
    // LimitOption: 0 is LIMIT_OPTION_COUNT, 1 is LIMIT_OPTION_WITH_TIES.
    if (fields.get(':limitOption') === '1') limits.push({ status: 'withTies' })
    else if (offset === undefined || count === undefined) limits.push({ status: 'notConstant' })
    else limits.push({ status: 'constant', settings: { offset: offset ?? 0, count } })
  }
  return limits
}

/**
 * The fields of the node that starts at `start` (its "{"), as name → value
 * text, leaving out those of the nodes inside it. A value is a word, "<>",
 * or a node in braces. Special characters inside words are escaped with a
 * backslash (outToken), so braces in names don't count.
 */
function ownFields(dump: string, start: number): Map<string, string> {
  const fields = new Map<string, string>()
  let depth = 0
  let i = start
  while (i < dump.length) {
    const char = dump[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) break
    } else if (char === ':' && depth === 1 && /\s/.test(dump[i - 1])) {
      const name = /^:[\w.]+/.exec(dump.slice(i))?.[0] ?? ':'
      let from = i + name.length
      while (/\s/.test(dump[from])) from++
      const end = valueEnd(dump, from)
      fields.set(name, dump.slice(from, end))
      i = end
      continue
    }
    i++
  }
  return fields
}

/** Where the value starting at `from` ends: after its closing brace for a node, else at the next whitespace or brace. */
function valueEnd(dump: string, from: number): number {
  if (dump[from] !== '{') {
    let end = from
    while (end < dump.length && !/[\s{}]/.test(dump[end])) end += dump[end] === '\\' ? 2 : 1
    return end
  }
  let depth = 0
  for (let i = from; i < dump.length; i++) {
    if (dump[i] === '\\') i++
    else if (dump[i] === '{') depth++
    else if (dump[i] === '}' && --depth === 0) return i + 1
  }
  return dump.length
}

/**
 * The number a LIMIT or OFFSET value holds: null for none ("<>", or a NULL
 * constant, as LIMIT ALL is), undefined for anything but a constant (a
 * parameter, or a subquery's result). The planner turns both into bigints, so
 * a constant's value is 8 bytes, lowest first, written as signed numbers.
 */
function constantValue(text: string): number | null | undefined {
  if (text === '<>') return null
  if (!/^\{CONST\s/.test(text)) return undefined
  const fields = ownFields(text, 0)
  if (fields.get(':constisnull') === 'true') return null
  const bytes = /:constvalue\s+\d+\s+\[([-\d\s]+)\]/.exec(text)?.[1].trim().split(/\s+/).map(Number)
  if (bytes === undefined || bytes.length !== 8) return undefined
  let value = 0n
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] & 0xff)
  return Number(BigInt.asIntN(64, value))
}
