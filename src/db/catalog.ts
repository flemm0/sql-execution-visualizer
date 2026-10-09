import type { PGliteInterface } from '@electric-sql/pglite'
import {
  assessTable,
  flushStatistics,
  readAutovacuumSettings,
  readTableActivity,
  type Assessment,
  type TableActivity,
} from './autovacuum'

/** What the schema browser shows: the database, its schemas, and their tables. */
export interface DatabaseInfo {
  /** current_database(), e.g. "postgres" */
  name: string
  schemas: SchemaInfo[]
}

export interface SchemaInfo {
  name: string
  tables: TableInfo[]
}

export interface TableInfo {
  schema: string
  name: string
  /** The planner's row estimate (pg_class.reltuples); -1 if the table was never analyzed. */
  estimatedRows: number
  /** Heap pages on disk. */
  pages: number
  sizeBytes: number
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  /** Autovacuum's counters for the table and what it would do now; null for partitioned tables, which it skips. */
  autovacuum: { activity: TableActivity; assessment: Assessment } | null
}

export interface ColumnInfo {
  name: string
  /** e.g. "integer", "numeric(10,2)", "timestamp with time zone" */
  type: string
  notNull: boolean
  primaryKey: boolean
}

export interface IndexInfo {
  name: string
  /** e.g. "CREATE INDEX ... USING btree (customer_id, order_date)" */
  definition: string
  unique: boolean
  primaryKey: boolean
  /** B-tree levels including the leaf level; null for other index types. */
  levels: number | null
  pages: number
}

/**
 * Schemas the browser leaves out: Postgres's own catalogs, and `visualizer`,
 * where the app keeps its bookkeeping (the seed version).
 */
const HIDDEN_SCHEMAS_SQL = `
  n.nspname NOT IN ('pg_catalog', 'information_schema', 'visualizer')
  AND n.nspname NOT LIKE 'pg\\_%'
`

/** The database's schemas, tables, columns and indexes, each list sorted by name (columns in table order). */
export async function loadCatalog(db: PGliteInterface): Promise<DatabaseInfo> {
  const database = await db.query<{ name: string }>('SELECT current_database() AS name')
  const schemaRows = await db.query<{ name: string }>(`
    SELECT n.nspname AS name FROM pg_namespace AS n WHERE ${HIDDEN_SCHEMAS_SQL} ORDER BY n.nspname
  `)

  const schemas = new Map<string, SchemaInfo>()
  for (const row of schemaRows.rows) schemas.set(row.name, { name: row.name, tables: [] })

  // Tables are keyed "schema.table" while columns and indexes are attached.
  const tables = new Map<string, TableInfo>()
  for (const table of await listTables(db)) {
    tables.set(`${table.schema}.${table.name}`, table)
    schemas.get(table.schema)?.tables.push(table)
  }
  for (const row of await listColumns(db)) {
    tables.get(`${row.schema_name}.${row.table_name}`)?.columns.push({
      name: row.column_name,
      type: row.data_type,
      notNull: row.not_null,
      primaryKey: row.primary_key,
    })
  }
  for (const row of await listIndexes(db)) {
    tables.get(`${row.schema_name}.${row.table_name}`)?.indexes.push({
      name: row.index_name,
      definition: row.index_definition,
      unique: row.is_unique,
      primaryKey: row.is_primary,
      levels: row.index_levels,
      pages: row.index_pages,
    })
  }
  // A separate query first, so the counters include the statement that just ran.
  await flushStatistics(db)
  const settings = await readAutovacuumSettings(db)
  for (const activity of await readTableActivity(db)) {
    const table = tables.get(`${activity.schema}.${activity.name}`)
    if (table) table.autovacuum = { activity, assessment: assessTable(activity, settings) }
  }

  return { name: database.rows[0].name, schemas: [...schemas.values()] }
}

interface TableRow {
  schema_name: string
  table_name: string
  table_rows: number
  table_pages: number
  table_bytes: number
}

async function listTables(db: PGliteInterface): Promise<TableInfo[]> {
  const result = await db.query<TableRow>(`
    SELECT
      n.nspname AS schema_name,
      t.relname AS table_name,
      t.reltuples::float8 AS table_rows,
      (pg_relation_size(t.oid) / current_setting('block_size')::int)::int AS table_pages,
      pg_relation_size(t.oid)::float8 AS table_bytes
    FROM pg_class AS t
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    WHERE ${HIDDEN_SCHEMAS_SQL} AND t.relkind IN ('r', 'p')
    ORDER BY n.nspname, t.relname
  `)
  return result.rows.map((row) => ({
    schema: row.schema_name,
    name: row.table_name,
    estimatedRows: row.table_rows,
    pages: row.table_pages,
    sizeBytes: row.table_bytes,
    columns: [],
    indexes: [],
    autovacuum: null,
  }))
}

interface ColumnRow {
  schema_name: string
  table_name: string
  column_name: string
  data_type: string
  not_null: boolean
  primary_key: boolean
}

async function listColumns(db: PGliteInterface) {
  const result = await db.query<ColumnRow>(`
    SELECT
      n.nspname AS schema_name,
      t.relname AS table_name,
      a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      COALESCE(a.attnum = ANY (pk.indkey), false) AS primary_key
    FROM pg_attribute AS a
    JOIN pg_class AS t ON t.oid = a.attrelid
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    LEFT JOIN pg_index AS pk ON pk.indrelid = t.oid AND pk.indisprimary
    WHERE ${HIDDEN_SCHEMAS_SQL} AND t.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY n.nspname, t.relname, a.attnum
  `)
  return result.rows
}

interface IndexRow {
  schema_name: string
  table_name: string
  index_name: string
  index_definition: string
  is_unique: boolean
  is_primary: boolean
  index_levels: number | null
  index_pages: number
}

async function listIndexes(db: PGliteInterface) {
  const result = await db.query<IndexRow>(`
    SELECT
      n.nspname AS schema_name,
      t.relname AS table_name,
      i.relname AS index_name,
      pg_get_indexdef(i.oid) AS index_definition,
      x.indisunique AS is_unique,
      x.indisprimary AS is_primary,
      -- The B-tree metapage counts the leaf level as 0.
      CASE WHEN am.amname = 'btree' THEN (SELECT level + 1 FROM bt_metap(i.oid::regclass::text)) END AS index_levels,
      (pg_relation_size(i.oid) / current_setting('block_size')::int)::int AS index_pages
    FROM pg_index AS x
    JOIN pg_class AS t ON t.oid = x.indrelid
    JOIN pg_class AS i ON i.oid = x.indexrelid
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    JOIN pg_am AS am ON am.oid = i.relam
    WHERE ${HIDDEN_SCHEMAS_SQL} AND t.relkind IN ('r', 'p')
    ORDER BY n.nspname, t.relname, i.relname
  `)
  return result.rows
}

/** e.g. "PostgreSQL 18.3" */
export async function postgresVersion(db: PGliteInterface) {
  const result = await db.query<{ version: string }>('SELECT version()')
  return result.rows[0].version.split(' on ')[0]
}
