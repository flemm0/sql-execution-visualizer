import type { PGliteInterface } from '@electric-sql/pglite'
import type { ScannedTable } from '../db/plan'
import { queryText } from '../db/query'
import { quoteIdentifier } from '../db/sql'
import type { RowRef } from './trace'

/*
 * Reads values from rows the replay names by ctid, as Postgres's text. A row
 * can be made of several tables' rows (a join's): it's one ctid per table,
 * and the query joins each table by its own ctid. Postgres evaluates the
 * expressions, as the plan deparses them, so the replay never re-implements SQL.
 */

/**
 * The values of `expressions` (SQL over the tables, by the names the query
 * calls them, e.g. "c.last_name" or "(a.id < b.id)") for each row, in the
 * order given, as text (null for NULL). `tables` are the scans a row's
 * ctids come from, in the same order as each row's ctids.
 */
export async function readValues(
  db: PGliteInterface,
  tables: ScannedTable[],
  rows: RowRef[][],
  expressions: string[],
): Promise<(string | null)[][]> {
  if (rows.length === 0) return []
  if (expressions.length === 0) return rows.map(() => [])
  const arrays = tables.map((_, i) => `ARRAY[${rows.map((row) => `'(${row[i].block},${row[i].offset})'`).join(', ')}]::tid[]`)
  const tidColumns = tables.map((_, i) => `replay_tid${i}`)
  const joins = tables.map(({ schema, name, alias }, i) => {
    const table = quoteIdentifier(alias)
    return `JOIN ONLY ${quoteIdentifier(schema)}.${quoteIdentifier(name)} AS ${table} ON ${table}.ctid = replay_wanted.replay_tid${i}`
  })
  const values = await queryText(
    db,
    `SELECT ${expressions.join(', ')}
     FROM unnest(${arrays.join(', ')}) WITH ORDINALITY AS replay_wanted(${tidColumns.join(', ')}, replay_position)
     ${joins.join('\n     ')}
     ORDER BY replay_wanted.replay_position`,
  )
  if (values.length !== rows.length) throw new Error(`${rows.length} rows to read, but Postgres found ${values.length}.`)
  return values
}
