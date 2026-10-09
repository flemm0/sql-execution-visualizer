import { messages, parse, type ParserOptions, type PGliteInterface, type Results } from '@electric-sql/pglite'
import { parsePlan, type Plan } from './plan'
import { query, sendQuery } from './query'
import { commandName, isQuery, splitStatements, statementAt, type Statement } from './statements'

/** The results pane shows at most this many rows of a result; the total is always reported. */
export const MAX_DISPLAYED_ROWS = 1000

/** What happened when one statement ran. */
export type StatementResult = RowsResult | DoneResult | ErrorResult | SkippedResult

interface ResultBase {
  statement: Statement
  /** e.g. "SELECT", "CREATE INDEX" */
  command: string
  /** Postgres's notices and warnings, e.g. 'NOTICE: table "t" does not exist, skipping'. */
  notices: string[]
}

/** A statement that returned rows (a SELECT, or e.g. INSERT ... RETURNING or SHOW). */
export interface RowsResult extends ResultBase {
  status: 'rows'
  columns: string[]
  /** Up to MAX_DISPLAYED_ROWS rows; each value is Postgres's own text for it, or null for NULL. */
  rows: (string | null)[][]
  totalRows: number
  /** The plan from EXPLAIN ANALYZE; null for statements that aren't queries (see isQuery). */
  plan: Plan | null
  durationMs: number
}

/** A statement that returned no rows, like CREATE INDEX or an UPDATE. */
export interface DoneResult extends ResultBase {
  status: 'done'
  /** Rows inserted, updated or deleted; null for statements that don't change rows. */
  affectedRows: number | null
  durationMs: number
}

/** A statement Postgres rejected. */
export interface ErrorResult extends ResultBase {
  status: 'error'
  message: string
  detail: string | null
  hint: string | null
  /** Where Postgres says the error is, as an offset into the editor text; null if it didn't say. */
  position: number | null
  /** Postgres's SQLSTATE code, e.g. "42P01" (undefined table). */
  code: string | null
}

/** A statement Run all didn't get to, because an earlier one failed. */
export interface SkippedResult extends ResultBase {
  status: 'skipped'
}

/**
 * Postgres sends every value as text. PGlite normally turns some of them into
 * JavaScript values (dates into Date objects, which shifts them into the
 * browser's time zone; json into objects). The results pane shows exactly what
 * Postgres sent instead, so every parser is replaced with one that keeps the
 * text. PGlite only has parsers for Postgres's built-in types, and those all
 * have type ids (OIDs) below 16384.
 */
const KEEP_TEXT: ParserOptions = Object.fromEntries(
  Array.from({ length: 16384 }, (_, oid) => [oid, (value: string) => value]),
)

const WRITING_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'])

/** Runs the statement under the cursor. */
export async function runStatementAt(db: PGliteInterface, sql: string, cursor: number): Promise<StatementResult[]> {
  const statement = statementAt(splitStatements(sql), cursor)
  return statement ? [await runStatement(db, statement)] : []
}

/** Runs every statement in order, stopping at the first error; the rest are reported as skipped. */
export async function runAll(db: PGliteInterface, sql: string): Promise<StatementResult[]> {
  const results: StatementResult[] = []
  for (const statement of splitStatements(sql)) {
    const failed = results.some((result) => result.status === 'error')
    results.push(
      failed ? { status: 'skipped', statement, command: commandName(statement), notices: [] } : await runStatement(db, statement),
    )
  }
  return results
}

/**
 * Runs one statement. A query (see isQuery) runs twice: first under
 * `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` for the real plan with
 * actual rows and buffer counts, then on its own for the rows. Other
 * statements run once, as typed.
 */
export async function runStatement(db: PGliteInterface, statement: Statement): Promise<StatementResult> {
  const command = commandName(statement)
  let plan: Plan | null = null
  if (isQuery(statement)) {
    try {
      const explain = await query<{ 'QUERY PLAN': unknown }>(
        db,
        `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.text}`,
      )
      plan = parsePlan(explain.rows[0]['QUERY PLAN'])
    } catch {
      // Fall through: running the statement itself reports the error, with
      // positions that match the editor text rather than the EXPLAIN prefix.
    }
  }

  const started = performance.now()
  const reply = await simpleQuery(db, statement.text)
  const durationMs = performance.now() - started
  const notices = reply.notices
  if (reply.status === 'error') return errorResult(statement, command, notices, reply.error)

  const result = reply.results[reply.results.length - 1]
  if (result.fields.length > 0) {
    const rows = result.rows as (string | null)[][]
    return {
      status: 'rows',
      statement,
      command,
      notices,
      columns: result.fields.map((field) => field.name),
      rows: rows.slice(0, MAX_DISPLAYED_ROWS),
      totalRows: rows.length,
      plan,
      durationMs,
    }
  }
  return {
    status: 'done',
    statement,
    command,
    notices,
    affectedRows: WRITING_COMMANDS.has(command) ? (result.affectedRows ?? 0) : null,
    durationMs,
  }
}

/**
 * Whether the session is inside a transaction block (after BEGIN, before
 * COMMIT or ROLLBACK), including one that failed. Postgres reports this at
 * the end of every reply; an empty query asks for it without doing anything.
 */
export async function inTransaction(db: PGliteInterface): Promise<boolean> {
  let status = 'I'
  for (const message of await sendQuery(db, '')) {
    // 'I' idle, 'T' in a transaction block, 'E' in a failed one.
    if (message instanceof messages.ReadyForQueryMessage) status = message.status
  }
  return status !== 'I'
}

type SimpleQueryReply =
  | { status: 'ok'; results: Results[]; notices: string[] }
  | { status: 'error'; error: messages.DatabaseError; notices: string[] }

/**
 * Sends one statement and reads the reply's rows, notices and error. Every
 * field of an error is kept: its position, DETAIL and HINT (see sendQuery).
 */
async function simpleQuery(db: PGliteInterface, sql: string): Promise<SimpleQueryReply> {
  const received = await sendQuery(db, sql)
  const notices: string[] = []
  let error: messages.DatabaseError | null = null
  for (const message of received) {
    if (message instanceof messages.NoticeMessage) notices.push(`${message.severity}: ${message.message}`)
    if (message instanceof messages.DatabaseError) error = message
  }
  if (error) return { status: 'error', error, notices }
  return { status: 'ok', results: parse.parseResults(received, {}, { rowMode: 'array', parsers: KEEP_TEXT }), notices }
}

function errorResult(
  statement: Statement,
  command: string,
  notices: string[],
  error: messages.DatabaseError,
): ErrorResult {
  return {
    status: 'error',
    statement,
    command,
    notices,
    message: error.message,
    detail: error.detail ?? null,
    hint: error.hint ?? null,
    // Postgres counts characters from 1 within the statement it was sent.
    position: error.position ? statement.from + Number(error.position) - 1 : null,
    code: error.code ?? null,
  }
}
