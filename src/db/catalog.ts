import type { PGliteInterface } from '@electric-sql/pglite'

export interface TableInfo {
  name: string
  /** The planner's row estimate (pg_class.reltuples); -1 if the table was never analyzed. */
  estimatedRows: number
  /** Heap pages on disk. */
  pages: number
  sizeBytes: number
  indexes: IndexInfo[]
}

export interface IndexInfo {
  name: string
  /** e.g. "CREATE INDEX ... USING btree (customer_id, order_date)" */
  definition: string
  /** B-tree levels including the leaf level; null for other index types. */
  levels: number | null
  pages: number
}

interface RelationRow {
  table_name: string
  table_rows: number
  table_pages: number
  table_bytes: number
  index_name: string | null
  index_definition: string | null
  index_levels: number | null
  index_pages: number | null
}

/** Tables in the public schema with their indexes, sorted by name. */
export async function listTables(db: PGliteInterface): Promise<TableInfo[]> {
  const result = await db.query<RelationRow>(`
    SELECT
      t.relname AS table_name,
      t.reltuples::float8 AS table_rows,
      (pg_relation_size(t.oid) / current_setting('block_size')::int)::int AS table_pages,
      pg_relation_size(t.oid)::float8 AS table_bytes,
      i.relname AS index_name,
      pg_get_indexdef(i.oid) AS index_definition,
      -- The B-tree metapage counts the leaf level as 0.
      CASE WHEN am.amname = 'btree' THEN (SELECT level + 1 FROM bt_metap(i.oid::regclass::text)) END AS index_levels,
      (pg_relation_size(i.oid) / current_setting('block_size')::int)::int AS index_pages
    FROM pg_class AS t
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    LEFT JOIN pg_index AS x ON x.indrelid = t.oid
    LEFT JOIN pg_class AS i ON i.oid = x.indexrelid
    LEFT JOIN pg_am AS am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND t.relkind = 'r'
    ORDER BY t.relname, i.relname
  `)

  const tables = new Map<string, TableInfo>()
  for (const row of result.rows) {
    let table = tables.get(row.table_name)
    if (!table) {
      table = {
        name: row.table_name,
        estimatedRows: row.table_rows,
        pages: row.table_pages,
        sizeBytes: row.table_bytes,
        indexes: [],
      }
      tables.set(row.table_name, table)
    }
    if (row.index_name !== null) {
      table.indexes.push({
        name: row.index_name,
        definition: row.index_definition ?? '',
        levels: row.index_levels,
        pages: row.index_pages ?? 0,
      })
    }
  }
  return [...tables.values()]
}

/** e.g. "PostgreSQL 18.3" */
export async function postgresVersion(db: PGliteInterface) {
  const result = await db.query<{ version: string }>('SELECT version()')
  return result.rows[0].version.split(' on ')[0]
}
