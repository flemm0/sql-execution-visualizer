/** Helpers for writing names and values into SQL text. */

/** A name as a SQL identifier, e.g. Bob's "Table" → "Bob's ""Table""". */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Text as a SQL string literal, e.g. Bob's → 'Bob''s'. */
export function quoteLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`
}
