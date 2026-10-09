import type { ReactNode } from 'react'
import { rows } from '../autovacuum/describe'
import type { TableInfo } from '../db/catalog'
import type { CatalogObject } from './tree'

interface DetailsPanelProps {
  object: CatalogObject | null
  /** Whether the autovacuum simulator is turned on (the editor toolbar's setting). */
  autovacuumOn: boolean
}

/** Facts about the object selected in the schema tree. Every number comes from the Postgres catalog. */
export function DetailsPanel({ object, autovacuumOn }: DetailsPanelProps) {
  return (
    <section
      aria-label="Details"
      className="max-h-[45%] shrink-0 overflow-auto border-t border-line bg-surface-1 px-3 py-2"
      data-testid="schema-details"
    >
      {object ? <Details object={object} autovacuumOn={autovacuumOn} /> : <p className="text-fg-muted">Select an object to see its details.</p>}
    </section>
  )
}

function Details({ object, autovacuumOn }: DetailsPanelProps & { object: CatalogObject }) {
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
          <AutovacuumFacts table={table} autovacuumOn={autovacuumOn} />
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

/**
 * How fresh the table's statistics are: autovacuum's counters next to the
 * thresholds that would make it act (see assessTable in db/autovacuum.ts).
 */
function AutovacuumFacts({ table, autovacuumOn }: { table: TableInfo; autovacuumOn: boolean }) {
  if (table.autovacuum === null) return null
  const { activity, assessment } = table.autovacuum
  const status = !autovacuumOn
    ? 'off (simulator turned off)'
    : assessment.enabled
      ? 'on'
      : 'off for this table (autovacuum_enabled)'
  return (
    <>
      <dt className="col-span-2 mt-2 text-fg-muted uppercase tracking-wide" data-testid="autovacuum-facts">
        Autovacuum
      </dt>
      <Fact label="Status">{status}</Fact>
      <Fact label="Last vacuum">{formatWhen(activity.lastVacuum)}</Fact>
      <Fact label="Last analyze">{formatWhen(activity.lastAnalyze)}</Fact>
      <Fact label="Changed since analyze">
        {rows(assessment.changedRows.count)}; analyzes above {assessment.changedRows.threshold.toLocaleString()}
      </Fact>
      <Fact label="Dead rows">
        {rows(assessment.deadRows.count)}; vacuums above {assessment.deadRows.threshold.toLocaleString()}
      </Fact>
      <Fact label="Inserted since vacuum">
        {rows(activity.insertedSinceVacuum)};{' '}
        {assessment.insertedRows
          ? `vacuums above ${assessment.insertedRows.threshold.toLocaleString()}`
          : 'insert vacuums off'}
      </Fact>
    </>
  )
}

/** Postgres's statistics start empty each time it starts, which in this app is every page load. */
function formatWhen(when: Date | null) {
  return when ? when.toLocaleTimeString() : 'not since this page loaded'
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
