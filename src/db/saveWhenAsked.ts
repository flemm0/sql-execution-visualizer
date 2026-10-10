import type { PGlite } from '@electric-sql/pglite'

/**
 * The PGlite methods PGlite's worker proxy calls to run a page's query. Each one
 * takes the query as its first argument and options as its second, and by
 * default saves the database to IndexedDB before answering.
 */
const QUERY_METHODS = new Set(['execProtocol', 'execProtocolRaw', 'execProtocolStream', 'execProtocolRawStream'])

/**
 * Returns the database as the pages see it through PGlite's worker proxy: their
 * queries no longer save it, and a page saves it by calling syncToFs(), which
 * waits until the save is done. The app does that once at the end of each run
 * and after Reset database (ADR 0023).
 *
 * By default PGlite saves after every query, reads included, and makes each
 * query wait about 40 ms for it. The proxy has no way to pass PGlite's
 * `syncToFs: false` option along, so this adds it here, in the worker.
 *
 * Queries run on `db` itself, like the seeding in db.worker.ts, still save.
 */
export function saveWhenAsked(db: PGlite): PGlite {
  // A Proxy stands in for `db`: each property the worker proxy reads goes through
  // `get` below, so it can hand out a changed version of a method.
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (typeof property === 'string' && QUERY_METHODS.has(property)) {
        return (message: Uint8Array, options: object = {}) => value.call(target, message, { ...options, syncToFs: false })
      }
      // PGlite keeps its state in private (#) fields, which only work when a
      // method runs with the real object as `this`, not the Proxy.
      return value.bind(target)
    },
  })
}
