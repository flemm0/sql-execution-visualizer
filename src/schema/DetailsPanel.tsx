import type { ReactNode } from 'react'
import type { CatalogObject } from './tree'

/** Facts about the object selected in the schema tree. Every number comes from the Postgres catalog. */
export function DetailsPanel({ object }: { object: CatalogObject | null }) {
  return (
    <section
      aria-label="Details"
      className="max-h-[45%] shrink-0 overflow-auto border-t border-line bg-surface-1 px-3 py-2"
      data-testid="schema-details"
    >
      {object ? <Details object={object} /> : <p className="text-fg-muted">Select an object to see its details.</p>}
    </section>
  )
}

function Details({ object }: { object: CatalogObject }) {
  switch (object.kind) {
    case 'database':
      return (
        <Facts kind="Database" name={object.database.name}>
          <Fact label="Schemas">{object.database.schemas.length}</Fact>
        </Facts>
      )
    case 'schema':
      return (
        <Facts kind="Schema" name={object.schema.name}>
          <Fact label="Tables">{object.schema.tables.length}</Fact>
        </Facts>
      )
    case 'table': {
      const table = object.table
      return (
        <Facts kind="Table" name={`${table.schema}.${table.name}`}>
          <Fact label="Rows (planner estimate)">{formatRows(table.estimatedRows)}</Fact>
          <Fact label="Heap pages">{table.pages.toLocaleString()}</Fact>
          <Fact label="Size on disk">{formatBytes(table.sizeBytes)}</Fact>
          <Fact label="Columns">{table.columns.length}</Fact>
          <Fact label="Indexes">{table.indexes.length}</Fact>
        </Facts>
      )
    }
    case 'column': {
      const column = object.column
      return (
        <Facts kind="Column" name={`${object.table.name}.${column.name}`}>
          <Fact label="Type">{column.type}</Fact>
          <Fact label="Nullable">{column.notNull ? 'no (NOT NULL)' : 'yes'}</Fact>
          <Fact label="Primary key">{column.primaryKey ? 'yes' : 'no'}</Fact>
        </Facts>
      )
    }
    case 'index': {
      const index = object.index
      return (
        <Facts kind="Index" name={index.name}>
          <Fact label="On table">{object.table.name}</Fact>
          <Fact label="Kind">{index.primaryKey ? 'primary key' : index.unique ? 'unique' : 'non-unique'}</Fact>
          {index.levels !== null && <Fact label="B-tree levels">{index.levels}</Fact>}
          <Fact label="Index pages">{index.pages.toLocaleString()}</Fact>
          <Fact label="Definition">{index.definition}</Fact>
        </Facts>
      )
    }
  }
}

function Facts({ kind, name, children }: { kind: string; name: string; children: ReactNode }) {
  return (
    <>
      <p className="text-xs text-fg-muted">{kind}</p>
      <h3 className="mb-1 font-mono text-sm break-all">{name}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">{children}</dl>
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-fg-muted">{label}</dt>
      <dd className="font-mono break-words">{children}</dd>
    </>
  )
}

function formatRows(rows: number) {
  return rows < 0 ? 'not analyzed yet' : `~${Math.round(rows).toLocaleString()}`
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
