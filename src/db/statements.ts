/**
 * Splitting editor text into SQL statements, finding the one under the
 * cursor, and telling queries apart from other statements. Plain text
 * processing: nothing here talks to Postgres.
 */

export interface Statement {
  /** The statement's text, without the semicolon that ends it. */
  text: string
  /** Where the statement starts and ends in the editor text (character offsets; `to` is exclusive). */
  from: number
  to: number
  /**
   * The statement's words outside strings, quoted identifiers and comments,
   * in upper case, e.g. ["SELECT", "FROM", "ORDERS", "WHERE", "ID"].
   * Used to classify the statement and name it.
   */
  words: string[]
}

/**
 * Splits text into statements at semicolons, the way psql does: semicolons
 * inside 'strings', "quoted identifiers", $$dollar-quoted bodies$$ and
 * comments don't end a statement. Statements made only of comments or
 * whitespace are dropped.
 *
 * Not handled: SQL-standard function bodies (BEGIN ATOMIC ... END), whose
 * inner semicolons are unquoted. Write such functions with $$ quoting.
 */
export function splitStatements(text: string): Statement[] {
  const statements: Statement[] = []
  let start = 0
  let words: string[] = []
  let i = 0

  function finish(end: number) {
    const leading = text.slice(start, end).search(/\S/)
    if (words.length > 0 && leading !== -1) {
      const from = start + leading
      const to = start + text.slice(start, end).trimEnd().length
      statements.push({ text: text.slice(from, to), from, to, words })
    }
    words = []
  }

  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '-' && next === '-') {
      // Line comment: skip to the end of the line.
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
    } else if (char === '/' && next === '*') {
      i = skipBlockComment(text, i)
    } else if (char === "'") {
      // E'...' strings allow backslash escapes; the E was read as a word just before.
      const escapes = /^E$/i.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '')
      if (escapes) words.pop()
      i = skipQuoted(text, i, "'", escapes)
      words.push('')
    } else if (char === '"') {
      i = skipQuoted(text, i, '"', false)
      words.push('')
    } else if (char === '$' && dollarTagAt(text, i) !== null) {
      const tag = dollarTagAt(text, i) as string
      const end = text.indexOf(tag, i + tag.length)
      i = end === -1 ? text.length : end + tag.length
      words.push('')
    } else if (char === ';') {
      finish(i)
      i += 1
      start = i
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i, i + 200)) as RegExpExecArray
      words.push(match[0].toUpperCase())
      i += match[0].length
    } else if (/[0-9]/.test(char)) {
      // A number. Pushed as a placeholder so the statement isn't mistaken for an empty one.
      const match = /^[0-9.eE]+/.exec(text.slice(i)) as RegExpExecArray
      words.push('')
      i += match[0].length
    } else {
      if (!/\s/.test(char) && words.length === 0) words.push('')
      i += 1
    }
  }
  finish(text.length)
  // Placeholders ('') for strings and numbers mark a statement as non-empty but aren't words.
  return statements.map((statement) => ({ ...statement, words: statement.words.filter((word) => word !== '') }))
}

/** Index just past a /* comment *\/. Postgres allows these to nest. */
function skipBlockComment(text: string, i: number) {
  let depth = 0
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      depth += 1
      i += 2
    } else if (text.startsWith('*/', i)) {
      depth -= 1
      i += 2
      if (depth === 0) return i
    } else {
      i += 1
    }
  }
  return i
}

/** Index just past a quoted string or identifier starting at i. A doubled quote ('' or "") is an escaped quote. */
function skipQuoted(text: string, i: number, quote: string, backslashEscapes: boolean) {
  i += 1
  while (i < text.length) {
    if (backslashEscapes && text[i] === '\\') {
      i += 2
    } else if (text[i] === quote) {
      if (text[i + 1] === quote) i += 2
      else return i + 1
    } else {
      i += 1
    }
  }
  return i
}

/** The dollar-quote tag starting at i ("$$" or "$body$"), or null if this $ isn't one (e.g. a $1 parameter). */
function dollarTagAt(text: string, i: number): string | null {
  // A $ right after an identifier character is part of that identifier.
  if (/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) return null
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64))
  return match ? match[0] : null
}

/**
 * The statement to run for a cursor position: the one the cursor is in, or,
 * when the cursor sits between statements, the one before it (so the cursor
 * just after a semicolon runs the statement it ends). Before the first
 * statement, the first one. Null when there are no statements.
 */
export function statementAt(statements: Statement[], cursor: number): Statement | null {
  let found: Statement | null = statements[0] ?? null
  for (const statement of statements) {
    if (statement.from <= cursor) found = statement
  }
  return found
}

/** Row-locking clauses (SELECT ... FOR UPDATE / FOR NO KEY UPDATE) read rows; they don't change them. */
function isLockingUpdate(words: string[], index: number) {
  return words[index - 1] === 'FOR' || (words[index - 1] === 'KEY' && words[index - 2] === 'NO')
}

/**
 * Whether a statement only reads: it starts with SELECT, WITH, VALUES or
 * TABLE and has no INSERT, UPDATE, DELETE, MERGE or INTO in it. These are run
 * twice (once under EXPLAIN ANALYZE for the plan, once for the rows), so a
 * statement that writes, like `WITH moved AS (DELETE ...) SELECT ...` or
 * `SELECT ... INTO new_table`, is treated as a plain statement instead.
 */
export function isQuery(statement: Statement) {
  const [first] = statement.words
  if (!['SELECT', 'WITH', 'VALUES', 'TABLE'].includes(first)) return false
  return statement.words.every((word, index) => {
    if (word === 'UPDATE') return isLockingUpdate(statement.words, index)
    return !['INSERT', 'DELETE', 'MERGE', 'INTO'].includes(word)
  })
}

/** Words that can sit between CREATE/DROP/ALTER and the kind of object. */
const OBJECT_MODIFIERS = new Set([
  'OR',
  'REPLACE',
  'UNIQUE',
  'TEMP',
  'TEMPORARY',
  'UNLOGGED',
  'GLOBAL',
  'LOCAL',
  'MATERIALIZED',
  'RECURSIVE',
  'TRUSTED',
  'PROCEDURAL',
])

/**
 * A short name for the statement, like psql's command tag: "SELECT",
 * "CREATE INDEX", "DROP TABLE", "CREATE MATERIALIZED VIEW".
 */
export function commandName(statement: Statement) {
  const [first, ...rest] = statement.words
  if (!['CREATE', 'DROP', 'ALTER'].includes(first)) return first ?? ''
  const name = [first]
  for (const word of rest) {
    if (word === 'MATERIALIZED') name.push(word)
    else if (OBJECT_MODIFIERS.has(word)) continue
    else {
      name.push(word)
      break
    }
  }
  return name.join(' ')
}
