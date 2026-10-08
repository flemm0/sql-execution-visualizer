import type { TableInfo } from '../db/catalog'

/** The tables and their indexes, with sizes. The full schema browser (columns, statistics) replaces this. */
export function TableList({ tables }: { tables: TableInfo[] }) {
  return (
    <ul className="divide-y divide-line">
      {tables.map((table) => (
        <li key={table.name} className="px-3 py-2" data-testid={`table-${table.name}`}>
          <code className="text-heap">{table.name}</code>
          <p className="text-xs text-fg-muted">
            {formatRows(table.estimatedRows)} · {table.pages.toLocaleString()} heap pages · {formatBytes(table.sizeBytes)}
          </p>
          <ul className="mt-1">
            {table.indexes.map((index) => (
              <li key={index.name} className="text-xs text-fg-muted">
                <code className="text-index">{index.name}</code>
                <br />
                {index.pages.toLocaleString()} pages
                {index.levels !== null && `, ${index.levels} ${index.levels === 1 ? 'level' : 'levels'}`}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

function formatRows(rows: number) {
  return rows < 0 ? 'not analyzed yet' : `~${Math.round(rows).toLocaleString()} rows`
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
