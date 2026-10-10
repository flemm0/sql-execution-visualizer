import { messages, parse, protocol, types, type ParserOptions, type PGliteInterface, type Results } from '@electric-sql/pglite'

/**
 * Sends SQL (one statement, or several separated by semicolons) with Postgres's
 * simple query protocol, as psql does, and decodes the reply here rather than
 * in the worker. Every query the app sends goes through this.
 *
 * PGlite's db.query and db.exec would be simpler, but in the browser they run in
 * the Web Worker, which has two costs:
 * - When they finish, they ask the worker to save the database to IndexedDB and
 *   wait for it, about 40 ms each (ADR 0023). The app saves once per run instead.
 * - On an error, the worker passes back only the message: the position, DETAIL
 *   and HINT are lost (ADR 0020).
 */
export async function sendQuery(db: PGliteInterface, sql: string): Promise<messages.BackendMessage[]> {
  // Until this tab is connected to the worker running Postgres (at startup, or
  // while the tabs elect a new one), a query sent now would be lost.
  await db.waitReady
  // PGlite's query lock, which db.query takes too. db.query sends a query in
  // several messages, and a query sent in between would break it. PGlite itself
  // runs one at startup, to learn Postgres's array types.
  return db.runExclusive(async () => {
    const reply = await db.execProtocolRaw(protocol.serialize.query(sql))
    const received: messages.BackendMessage[] = []
    new protocol.Parser().parse(reply, (message) => received.push(message))
    return received
  })
}

/**
 * Postgres sends every value as text. PGlite normally turns some of them into
 * JavaScript values (dates into Date objects, which shifts them into the
 * browser's time zone; json into objects). The results pane shows exactly what
 * Postgres sent instead, so every parser is replaced with one that keeps the
 * text. PGlite only has parsers for Postgres's built-in types, and those all
 * have type ids (OIDs) below 16384.
 */
export const KEEP_TEXT: ParserOptions = Object.fromEntries(
  Array.from({ length: 16384 }, (_, oid) => [oid, (value: string) => value]),
)

/**
 * Runs SQL and returns the last statement's rows as Postgres's own text for
 * each value (null for NULL), the way the results pane shows them. Throws
 * Postgres's error if a statement fails.
 */
export async function queryText(db: PGliteInterface, sql: string): Promise<(string | null)[][]> {
  const received = await sendQuery(db, sql)
  const error = received.find((message) => message instanceof messages.DatabaseError)
  if (error) throw error
  const results = parse.parseResults(received, {}, { rowMode: 'array', parsers: KEEP_TEXT })
  return results[results.length - 1].rows as (string | null)[][]
}

/**
 * Runs SQL and returns the last statement's result, with values turned into
 * JavaScript values the way db.query does it (numbers, booleans, Dates, and
 * objects for json). Throws Postgres's error if a statement fails.
 *
 * The <T> says what each row looks like. TypeScript takes it on trust, so the
 * column names in the SQL have to match it.
 */
export async function query<T>(db: PGliteInterface, sql: string): Promise<Results<T>> {
  const received = await sendQuery(db, sql)
  const error = received.find((message) => message instanceof messages.DatabaseError)
  if (error) throw error
  const results = parse.parseResults(received, types.parsers)
  return results[results.length - 1] as Results<T>
}
