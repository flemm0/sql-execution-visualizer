import type { RowsResult, StatementResult } from '../db/runner'

const integer = new Intl.NumberFormat('en-US')
const milliseconds = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

interface ResultsPaneProps {
  results: StatementResult[]
  /** Called when a visitor clicks an error's position, with the offset in the editor text. */
  onShowPosition: (position: number) => void
  /** The editor text the results came from, to turn error positions into line and column numbers. */
  sql: string
}

/**
 * What the last run did: one status line per statement, then the rows of the
 * last statement that returned any (at most 1,000 shown, with the total).
 */
export function ResultsPane({ results, onShowPosition, sql }: ResultsPaneProps) {
  const lastRows = results.filter((result): result is RowsResult => result.status === 'rows').at(-1)
  return (
    <div className="flex h-full flex-col">
      <ol className="shrink-0 border-b border-line px-3 py-2 font-mono text-xs" aria-label="Statements run" data-testid="run-log">
        {results.map((result, index) => (
          <li key={index} data-testid="run-status" data-status={result.status}>
            <StatusLine result={result} onShowPosition={onShowPosition} sql={sql} />
            {result.notices.map((notice, noticeIndex) => (
              <div key={noticeIndex} className="pl-4 text-fg-muted" data-testid="sql-notice">
                {notice}
              </div>
            ))}
          </li>
        ))}
      </ol>
      {lastRows && <ResultTable result={lastRows} />}
    </div>
  )
}

interface StatusLineProps {
  result: StatementResult
  onShowPosition: (position: number) => void
  sql: string
}

function StatusLine({ result, onShowPosition, sql }: StatusLineProps) {
  switch (result.status) {
    case 'rows':
      return (
        <span>
          <span className="text-fg-muted">✓</span> {result.command}: {integer.format(result.totalRows)}{' '}
          {result.totalRows === 1 ? 'row' : 'rows'}, {milliseconds.format(result.durationMs)} ms
        </span>
      )
    case 'done':
      return (
        <span>
          <span className="text-fg-muted">✓</span> {result.command}:{' '}
          {result.affectedRows === null
            ? 'done'
            : `${integer.format(result.affectedRows)} ${result.affectedRows === 1 ? 'row' : 'rows'}`}
          , {milliseconds.format(result.durationMs)} ms
        </span>
      )
    case 'error': {
      const where = result.position === null ? null : lineAndColumn(sql, result.position)
      return (
        <div className="text-fg" data-testid="sql-error">
          <span className="text-rejected">✗ ERROR:</span> {result.message}
          {where && result.position !== null && (
            <>
              {' '}
              <button
                type="button"
                className="text-index underline-offset-2 hover:underline"
                onClick={() => onShowPosition(result.position as number)}
              >
                (line {where.line}, column {where.column})
              </button>
            </>
          )}
          {result.detail && <div className="pl-4 text-fg-muted">DETAIL: {result.detail}</div>}
          {result.hint && <div className="pl-4 text-fg-muted">HINT: {result.hint}</div>}
        </div>
      )
    }
    case 'skipped':
      return (
        <span className="text-fg-muted">
          – {result.command}: not run, because an earlier statement failed
        </span>
      )
  }
}

/** 1-based line and column of an offset in the text. */
function lineAndColumn(text: string, offset: number) {
  const before = text.slice(0, offset).split('\n')
  return { line: before.length, column: before[before.length - 1].length + 1 }
}

function ResultTable({ result }: { result: RowsResult }) {
  const shown = result.rows.length
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {shown < result.totalRows && (
        <p className="px-3 py-1 text-xs text-fg-muted" data-testid="rows-cap">
          Showing the first {integer.format(shown)} of {integer.format(result.totalRows)} rows.
        </p>
      )}
      <table className="w-max min-w-full border-collapse font-mono text-xs" data-testid="result-table">
        <thead className="sticky top-0 bg-surface-1">
          <tr>
            {result.columns.map((column, index) => (
              <th key={index} scope="col" className="border-b border-line px-3 py-1 text-left font-semibold">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-surface-1">
              {row.map((value, columnIndex) => (
                <td key={columnIndex} className="border-b border-line px-3 py-0.5 whitespace-pre">
                  {value === null ? <span className="text-fg-muted italic">NULL</span> : value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
