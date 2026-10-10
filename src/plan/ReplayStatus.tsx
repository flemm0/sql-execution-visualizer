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
          {checks.map((check) => (
            <tr
              key={check.label}
              className={check.ok ? 'text-fg' : 'text-rejected'}
              data-testid="replay-check"
              data-check={check.label}
            >
              <td className="pr-3">
                {check.ok ? '✓' : '✗'} {check.label}
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
