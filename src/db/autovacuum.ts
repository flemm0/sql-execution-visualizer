import type { PGliteInterface } from '@electric-sql/pglite'
import { query } from './query'

/*
 * PGlite runs Postgres as a single process, so there is no autovacuum. This
 * module does what the autovacuum launcher would: it reads each table's
 * counters from pg_stat_user_tables, compares them with the same thresholds
 * Postgres 18 uses (relation_needs_vacanalyze in src/backend/postmaster/autovacuum.c),
 * and runs VACUUM and/or ANALYZE on the tables that cross them.
 * See docs/decisions/0014-simulated-autovacuum.md and 0021-autovacuum-simulator.md.
 */

/** The server-wide autovacuum settings (postgresql.conf); a table's storage parameters can override each one. */
export interface AutovacuumSettings {
  vacuumThreshold: number
  vacuumScaleFactor: number
  /** Caps the dead-row threshold on big tables; -1 means no cap. */
  vacuumMaxThreshold: number
  /** -1 turns off vacuuming for inserts. */
  insertThreshold: number
  insertScaleFactor: number
  analyzeThreshold: number
  analyzeScaleFactor: number
}

/** One table's counters, as autovacuum reads them. */
export interface TableActivity {
  schema: string
  name: string
  /** The planner's row estimate (pg_class.reltuples); -1 if the table was never vacuumed or analyzed. */
  estimatedRows: number
  /** pg_class.relpages and relallfrozen, as of the last VACUUM or ANALYZE. */
  pages: number
  allFrozenPages: number
  /** Row versions that are dead but not yet removed (n_dead_tup). */
  deadRows: number
  /** Rows inserted since the last vacuum (n_ins_since_vacuum). */
  insertedSinceVacuum: number
  /** Rows inserted, updated or deleted since the last analyze (n_mod_since_analyze). */
  changedSinceAnalyze: number
  /** The last VACUUM or ANALYZE, by hand or by autovacuum, since Postgres started; null if none. */
  lastVacuum: Date | null
  lastAnalyze: Date | null
  /** The table's storage parameters, e.g. { autovacuum_enabled: 'off' }. */
  options: Record<string, string>
}

/** A counter and the threshold it has to go over. */
export interface Measure {
  count: number
  /** Autovacuum acts when count is greater than this. Rounded down: counts are whole rows. */
  threshold: number
}

/** What autovacuum would decide for one table right now. */
export interface Assessment {
  /** False when the table's autovacuum_enabled storage parameter is off. */
  enabled: boolean
  deadRows: Measure
  /** Null when vacuuming for inserts is turned off (an insert threshold of -1). */
  insertedRows: Measure | null
  changedRows: Measure
  vacuum: boolean
  analyze: boolean
}

/** What the simulator did to one table. */
export interface AutovacuumAction {
  schema: string
  table: string
  vacuumed: boolean
  analyzed: boolean
  /** The counters that triggered it, as they were just before. */
  assessment: Assessment
}

/**
 * Makes this session's pending statistics visible in pg_stat_user_tables.
 *
 * Postgres counts a session's inserts, updates and deletes locally and adds
 * them to the shared counters when the session goes idle, at most once a
 * second. A real server sets a timer to flush what's left; PGlite never runs
 * it, so recent writes can stay invisible until the next statement after a
 * one-second pause. pg_stat_force_next_flush() makes the next flush happen
 * as soon as this statement finishes, so the following query sees every write.
 */
export async function flushStatistics(db: PGliteInterface) {
  await query(db, 'SELECT pg_stat_force_next_flush()')
}

export async function readAutovacuumSettings(db: PGliteInterface): Promise<AutovacuumSettings> {
  const result = await query<Record<string, number>>(db, `
    SELECT
      current_setting('autovacuum_vacuum_threshold')::float8 AS vacuum_threshold,
      current_setting('autovacuum_vacuum_scale_factor')::float8 AS vacuum_scale_factor,
      current_setting('autovacuum_vacuum_max_threshold')::float8 AS vacuum_max_threshold,
      current_setting('autovacuum_vacuum_insert_threshold')::float8 AS insert_threshold,
      current_setting('autovacuum_vacuum_insert_scale_factor')::float8 AS insert_scale_factor,
      current_setting('autovacuum_analyze_threshold')::float8 AS analyze_threshold,
      current_setting('autovacuum_analyze_scale_factor')::float8 AS analyze_scale_factor
  `)
  const row = result.rows[0]
  return {
    vacuumThreshold: row.vacuum_threshold,
    vacuumScaleFactor: row.vacuum_scale_factor,
    vacuumMaxThreshold: row.vacuum_max_threshold,
    insertThreshold: row.insert_threshold,
    insertScaleFactor: row.insert_scale_factor,
    analyzeThreshold: row.analyze_threshold,
    analyzeScaleFactor: row.analyze_scale_factor,
  }
}

interface ActivityRow {
  schema_name: string
  table_name: string
  reltuples: number
  relpages: number
  relallfrozen: number
  n_dead_tup: number
  n_ins_since_vacuum: number
  n_mod_since_analyze: number
  last_vacuum: Date | null
  last_analyze: Date | null
  reloptions: string[] | null
}

/**
 * The counters of every table autovacuum looks after: ordinary tables and
 * materialized views, but not temporary tables (autovacuum can't reach
 * another session's temporary tables) or the app's own `visualizer` schema.
 * Call flushStatistics first, in an earlier query, to include recent writes.
 */
export async function readTableActivity(db: PGliteInterface): Promise<TableActivity[]> {
  const result = await query<ActivityRow>(db, `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      c.reltuples::float8 AS reltuples,
      c.relpages,
      c.relallfrozen,
      s.n_dead_tup::float8 AS n_dead_tup,
      s.n_ins_since_vacuum::float8 AS n_ins_since_vacuum,
      s.n_mod_since_analyze::float8 AS n_mod_since_analyze,
      greatest(s.last_vacuum, s.last_autovacuum) AS last_vacuum,
      greatest(s.last_analyze, s.last_autoanalyze) AS last_analyze,
      -- As json, which turns into a JavaScript array (or null).
      to_json(c.reloptions) AS reloptions
    FROM pg_stat_user_tables AS s
    JOIN pg_class AS c ON c.oid = s.relid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm') AND c.relpersistence <> 't' AND n.nspname <> 'visualizer'
    ORDER BY n.nspname, c.relname
  `)
  return result.rows.map((row) => ({
    schema: row.schema_name,
    name: row.table_name,
    estimatedRows: row.reltuples,
    pages: row.relpages,
    allFrozenPages: row.relallfrozen,
    deadRows: row.n_dead_tup,
    insertedSinceVacuum: row.n_ins_since_vacuum,
    changedSinceAnalyze: row.n_mod_since_analyze,
    lastVacuum: row.last_vacuum,
    lastAnalyze: row.last_analyze,
    options: parseOptions(row.reloptions),
  }))
}

/** Turns pg_class.reloptions, e.g. ['autovacuum_enabled=off'], into { autovacuum_enabled: 'off' }. */
function parseOptions(reloptions: string[] | null): Record<string, string> {
  const options: Record<string, string> = {}
  for (const option of reloptions ?? []) {
    const equals = option.indexOf('=')
    options[option.slice(0, equals)] = option.slice(equals + 1)
  }
  return options
}

/**
 * Decides, as Postgres 18's autovacuum does, whether a table needs VACUUM
 * and/or ANALYZE. With the default settings:
 *
 * - vacuum when dead rows > 50 + 20% of the table's rows,
 *   or rows inserted since the last vacuum > 1,000 + 20% of its not-yet-frozen rows;
 * - analyze when rows changed since the last analyze > 50 + 10% of its rows.
 *
 * "The table's rows" is the planner's estimate (pg_class.reltuples), not the
 * live count. The anti-wraparound vacuum, which ignores these thresholds, is
 * left out: it needs 200 million transactions.
 */
export function assessTable(table: TableActivity, settings: AutovacuumSettings): Assessment {
  // A storage parameter set on the table wins over the server-wide setting.
  // Postgres checks the values when they're set, so they're always in range.
  const option = (name: string, serverSetting: number) =>
    table.options[name] === undefined ? serverSetting : Number(table.options[name])
  const vacuumThreshold = option('autovacuum_vacuum_threshold', settings.vacuumThreshold)
  const vacuumScaleFactor = option('autovacuum_vacuum_scale_factor', settings.vacuumScaleFactor)
  const vacuumMaxThreshold = option('autovacuum_vacuum_max_threshold', settings.vacuumMaxThreshold)
  const insertThreshold = option('autovacuum_vacuum_insert_threshold', settings.insertThreshold)
  const insertScaleFactor = option('autovacuum_vacuum_insert_scale_factor', settings.insertScaleFactor)
  const analyzeThreshold = option('autovacuum_analyze_threshold', settings.analyzeThreshold)
  const analyzeScaleFactor = option('autovacuum_analyze_scale_factor', settings.analyzeScaleFactor)

  // A table that was never vacuumed or analyzed counts as empty.
  const rows = Math.max(table.estimatedRows, 0)
  // Inserts only count against the part of the table that isn't frozen yet.
  const unfrozen =
    table.pages > 0 && table.allFrozenPages > 0 ? 1 - Math.min(table.allFrozenPages, table.pages) / table.pages : 1

  let deadThreshold = vacuumThreshold + vacuumScaleFactor * rows
  if (vacuumMaxThreshold >= 0) deadThreshold = Math.min(deadThreshold, vacuumMaxThreshold)
  const deadRows = { count: table.deadRows, threshold: Math.floor(deadThreshold) }
  const insertedRows =
    insertThreshold >= 0
      ? {
          count: table.insertedSinceVacuum,
          threshold: Math.floor(insertThreshold + insertScaleFactor * rows * unfrozen),
        }
      : null
  const changedRows = {
    count: table.changedSinceAnalyze,
    threshold: Math.floor(analyzeThreshold + analyzeScaleFactor * rows),
  }

  const enabled = table.options.autovacuum_enabled === undefined || parseBoolean(table.options.autovacuum_enabled)
  return {
    enabled,
    deadRows,
    insertedRows,
    changedRows,
    vacuum: enabled && (crossed(deadRows) || (insertedRows !== null && crossed(insertedRows))),
    analyze: enabled && crossed(changedRows),
  }
}

export function crossed(measure: Measure) {
  return measure.count > measure.threshold
}

/** Postgres's spellings of a boolean parameter: on/off, true/false, yes/no, 1/0, and their prefixes. */
function parseBoolean(value: string) {
  const text = value.toLowerCase()
  const isPrefixOf = (word: string, shortest: number) => text.length >= shortest && word.startsWith(text)
  return !(isPrefixOf('false', 1) || isPrefixOf('no', 1) || isPrefixOf('off', 2) || text === '0')
}

/**
 * Checks every table and runs VACUUM and/or ANALYZE on the ones over their
 * thresholds, as autovacuum would within a minute on a real server.
 * Returns what it did. Must not be called inside a transaction block:
 * VACUUM can't run there (see inTransaction in runner.ts).
 */
export async function runAutovacuum(db: PGliteInterface): Promise<AutovacuumAction[]> {
  await flushStatistics(db)
  const settings = await readAutovacuumSettings(db)
  const actions: AutovacuumAction[] = []
  for (const table of await readTableActivity(db)) {
    const assessment = assessTable(table, settings)
    if (!assessment.vacuum && !assessment.analyze) continue
    const name = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`
    // Autovacuum does both in one pass when both are due.
    const command = assessment.vacuum ? (assessment.analyze ? `VACUUM (ANALYZE) ${name}` : `VACUUM ${name}`) : `ANALYZE ${name}`
    await query(db, command)
    actions.push({
      schema: table.schema,
      table: table.name,
      vacuumed: assessment.vacuum,
      analyzed: assessment.analyze,
      assessment,
    })
  }
  return actions
}

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}
