import { worker } from '@electric-sql/pglite/worker'
import { createDatabase } from './createDatabase'
import { ensureSeeded } from './seed'

/** Where the database lives in the browser's IndexedDB, so changes survive reloads. */
const DATA_DIR = 'idb://sql-execution-visualizer'

// Postgres runs here, off the main thread, so the UI stays responsive.
// With several tabs open, PGlite elects one tab's worker to run Postgres and the
// others forward their queries to it, so init (and seeding) runs once.
worker({
  async init(options) {
    const db = await createDatabase({ ...options, dataDir: DATA_DIR })
    // The first visit generates the seed data (about a second); later visits load it.
    await ensureSeeded(db)
    return db
  },
})
