import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { DatabaseInfo } from '../db/catalog'
import { splitStatements, statementAt } from '../db/statements'

/** A column the statement can refer to without naming its table, e.g. `status` in `SELECT * FROM orders WHERE status = ...`. */
export interface ColumnInScope {
  name: string
  /** The tables in the statement that have a column by this name, e.g. ["customers", "orders"] for `id`. */
  tables: string[]
}

/**
 * The columns of every catalog table the statement names, sorted by name.
 * `statementWords` are the statement's words in upper case, as
 * splitStatements gives them. A table counts as named when its name is one of
 * the words, so `FROM orders o JOIN public.customers c` brings in the columns
 * of both. A column two tables share (like `id`) is listed once.
 */
export function columnsInScope(database: DatabaseInfo | null, statementWords: string[]): ColumnInScope[] {
  const words = new Set(statementWords)
  const columns = new Map<string, ColumnInScope>()
  for (const schema of database?.schemas ?? []) {
    for (const table of schema.tables) {
      if (!words.has(table.name.toUpperCase())) continue
      for (const column of table.columns) {
        const found = columns.get(column.name)
        if (found === undefined) columns.set(column.name, { name: column.name, tables: [table.name] })
        else if (!found.tables.includes(table.name)) found.tables.push(table.name)
      }
    }
  }
  return [...columns.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Syntax nodes where a column name can't go: inside a string, a quoted identifier or a comment. */
const NOT_HERE = ['String', 'QuotedIdentifier', 'LineComment', 'BlockComment']

/**
 * A completion source for columns written without their table. CodeMirror's
 * SQL support only completes columns after `table.`, so typing
 * `WHERE stat` would offer the keyword STATE but not the column `status`.
 * This source offers the columns of the tables the statement under the cursor
 * names, ranked above keywords. After a `.`, it stays out of the way and
 * lets the SQL support complete the qualified name.
 */
export function columnCompletionSource(database: DatabaseInfo | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_$]*/)
    const from = word?.from ?? context.pos
    // Without a typed letter, only show columns when asked (Ctrl+Space).
    if (word === null && !context.explicit) return null
    if (context.state.sliceDoc(from - 1, from) === '.') return null
    if (NOT_HERE.includes(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null

    const text = context.state.doc.toString()
    const statement = statementAt(splitStatements(text), context.pos)
    if (statement === null) return null
    const columns = columnsInScope(database, statement.words)
    if (columns.length === 0) return null

    const options: Completion[] = columns.map((column) => ({
      label: column.name,
      apply: quoteIfNeeded(column.name),
      detail: column.tables.join(', '),
      type: 'property',
      // Above keywords (boost 0), so `stat` offers `status` before STATE.
      boost: 1,
    }))
    return { from, options, validFor: /^[A-Za-z0-9_$]*$/ }
  }
}

/** Postgres folds unquoted names to lower case, so a name with capitals or other characters needs "quotes". */
function quoteIfNeeded(name: string) {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}
