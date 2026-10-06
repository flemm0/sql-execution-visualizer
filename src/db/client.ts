import { PGliteWorker } from '@electric-sql/pglite/worker'

/** Starts the database Web Worker and returns a connection to it. */
export function connectToDatabase() {
  return PGliteWorker.create(new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' }))
}
