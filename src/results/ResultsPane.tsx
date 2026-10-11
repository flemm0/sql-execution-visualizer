import { useEffect, useRef } from 'react'
import type { RowsResult, StatementResult } from '../db/runner'

const integer = new Intl.NumberFormat('en-US')
const milliseconds = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** A query's result filling in while its animation plays: the rows emitted so far. */
export interface Filling {
  result: RowsResult
  /** How many of its rows the animation has sent to the result. */
  rows: number
}

interface ResultsPaneProps {
  results: StatementResult[]
  /** Called when a visitor clicks an error's position, with the offset in the editor text. */
  onShowPosition: (position: number) => void
  /** The editor text the results came from, to turn error positions into line and column numbers. */
  sql: string
  /** Set while the animation of a query plays; its result shows only the rows emitted so far. */
  filling: Filling | null
  /** Moves the animation to its end, revealing the whole result. */
  onSkipToEnd: () => void
}

/**
 * What the last run did: one status line per statement, then the rows of the
 * last statement that returned any (at most 1,000 shown, with the total).
 * While its animation plays, rows appear as they're emitted.
 */
export function ResultsPane({ results, onShowPosition, sql, filling, onSkipToEnd }: ResultsPaneProps) {
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
      {lastRows && (
        <ResultTable
          result={lastRows}
          filling={filling?.result === lastRows ? filling.rows : null}
          onSkipToEnd={onSkipToEnd}
        />
      )}
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

interface ResultTableProps {
  result: RowsResult
  /** How many rows have been emitted so far, while the animation plays; null to show them all. */
  filling: number | null
  onSkipToEnd: () => void
}

function ResultTable({ result, filling, onSkipToEnd }: ResultTableProps) {
  const rows = filling === null ? result.rows : result.rows.slice(0, filling)
  const shown = result.rows.length
  // The row emitted last, highlighted and kept in view as the result fills in.
  const latest = filling !== null && filling > 0 && filling <= result.rows.length ? filling - 1 : null
  const latestRow = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    latestRow.current?.scrollIntoView({ block: 'nearest' })
  }, [latest])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {filling !== null && (
        <p className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs text-fg-muted" data-testid="rows-filling">
          <span>
            Rows appear as the animation sends them to the result: {integer.format(filling)} of{' '}
            {integer.format(result.totalRows)} so far
            {filling > shown && ` (the first ${integer.format(shown)} shown)`}.
          </span>
          <button type="button" className="btn text-xs" onClick={onSkipToEnd}>
            Skip to end
          </button>
        </p>
      )}
      {filling === null && shown < result.totalRows && (
        <p className="shrink-0 px-3 py-1 text-xs text-fg-muted" data-testid="rows-cap">
          Showing the first {integer.format(shown)} of {integer.format(result.totalRows)} rows.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
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
            {rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                ref={rowIndex === latest ? latestRow : undefined}
                className={rowIndex === latest ? 'text-result' : 'hover:bg-surface-1'}
                data-latest={rowIndex === latest ? '' : undefined}
              >
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
    </div>
  )
}
