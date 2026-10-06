import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { pageinspect } from '@electric-sql/pglite/contrib/pageinspect'
import { pg_buffercache } from '@electric-sql/pglite/contrib/pg_buffercache'

/**
 * Starts Postgres with the extensions the visualizer reads internals through:
 * pageinspect (raw heap and B-tree pages) and pg_buffercache (the shared buffer cache).
 * The browser calls this inside a Web Worker; tests call it directly in Node.
 */
export async function createDatabase(options: PGliteOptions = {}) {
  const db = await PGlite.create({ ...options, extensions: { pageinspect, pg_buffercache } })
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS pageinspect;
    CREATE EXTENSION IF NOT EXISTS pg_buffercache;
  `)
  return db
}
