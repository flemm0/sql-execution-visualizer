import { worker } from '@electric-sql/pglite/worker'
import { createDatabase } from './createDatabase'

// Postgres runs here, off the main thread, so the UI stays responsive.
worker({ init: (options) => createDatabase(options) })
