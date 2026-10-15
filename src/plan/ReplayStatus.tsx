import type { GlossaryTerm } from '../glossary/glossary'
import { Term } from '../glossary/Term'
import type { Replay } from '../replay/replay'

const integer = new Intl.NumberFormat('en-US')

/**
 * Whether the replay of the query matches what Postgres reported, with each
 * check, or why the query can't be animated yet. A mismatch is shown, never
 * hidden: the checks open by themselves.
 */
export function ReplayStatus({ replay }: { replay: Replay }) {
  if (replay.status === 'unsupported') {
    return (
      <p className="mt-3 text-fg-muted" data-testid="replay-status">
        {replay.reason}
      </p>
    )
  }
  if (replay.status === 'failed') {
    return (
      <p className="mt-3" data-testid="replay-status">
        <span className="text-rejected">✗ The replay failed:</span> {replay.message}
      </p>
    )
  }

  const { ok, checks, notes } = replay.validation
  return (
    // Keyed by outcome, so a mismatch after a match opens the list again.
    <details key={String(ok)} className="mt-3" open={!ok} data-testid="replay-status">
      <summary className="cursor-pointer">
        {ok ? (
          <span className="text-fg">✓ Replay matches Postgres</span>
        ) : (
          <span className="text-rejected">✗ Replay doesn’t match Postgres</span>
        )}
        <span className="text-fg-muted"> · {checks.length} checks</span>
      </summary>
      <table className="mt-1 font-mono">
        <thead className="text-left text-fg-muted">
          <tr>
            <th className="pr-3 font-normal">Check</th>
            <th className="pr-3 text-right font-normal">Postgres</th>
            <th className="pr-3 text-right font-normal">Replay</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check, i) => (
            <tr
              // Two joins in one plan can share a heading, and so their checks' labels.
              key={i}
              className={check.ok ? 'text-fg' : 'text-rejected'}
              data-testid="replay-check"
              data-check={check.label}
            >
              <td className="pr-3">
                {check.ok ? '✓' : '✗'} <CheckLabel label={check.label} />
                {/* Postgres reports this count as an average per loop: both numbers are. */}
                {check.loops !== undefined && <span className="text-fg-muted"> per loop, of {integer.format(check.loops)}</span>}
              </td>
              <td className="pr-3 text-right">{integer.format(check.postgres)}</td>
              <td className="pr-3 text-right">{integer.format(check.replay)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes.map((note) => (
        <p key={note} className="mt-1 text-fg-muted">
          {note}
        </p>
      ))}
    </details>
  )
}

/** What a check compares, after its plan node's heading (validate.ts), and the term for it. */
const CHECK_TERMS: Record<string, GlossaryTerm> = {
  'rows removed by filter': 'Rows Removed by Filter',
  'rows removed by join filter': 'Rows Removed by Join Filter',
  'index searches': 'Index Searches',
  'heap fetches': 'Heap Fetches',
  'exact heap blocks': 'Exact Heap Blocks',
  'buffer hits': 'buffer hit',
  'buffer reads': 'buffer read',
}

/** A check's label, e.g. "Seq Scan on orders: buffer reads", with what it compares marked as a term. */
function CheckLabel({ label }: { label: string }) {
  const split = label.lastIndexOf(': ')
  const what = label.slice(split + 2)
  const term = split === -1 ? undefined : CHECK_TERMS[what]
  if (term === undefined) return <>{label}</>
  return (
    <>
      {label.slice(0, split + 2)}
      <Term term={term}>{what}</Term>
    </>
  )
}
