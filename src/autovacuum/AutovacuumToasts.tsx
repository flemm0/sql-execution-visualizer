import { useEffect } from 'react'
import type { AutovacuumAction } from '../db/autovacuum'
import { actionReasons, actionTitle } from './describe'

/** How long a notice stays up unless closed sooner. */
const SHOW_FOR_MS = 10_000

export interface AutovacuumNotice {
  id: number
  action: AutovacuumAction
}

interface AutovacuumToastsProps {
  notices: AutovacuumNotice[]
  onDismiss: (id: number) => void
}

/** Small notices in the bottom-right corner, one per table the autovacuum simulator vacuumed or analyzed. */
export function AutovacuumToasts({ notices, onDismiss }: AutovacuumToastsProps) {
  return (
    // A live region: screen readers announce notices as they appear.
    <div className="pointer-events-none fixed right-4 bottom-4 z-10 flex w-96 flex-col gap-2" role="status" aria-live="polite">
      {notices.map((notice) => (
        <Toast key={notice.id} notice={notice} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function Toast({ notice, onDismiss }: { notice: AutovacuumNotice; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(notice.id), SHOW_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [notice.id, onDismiss])

  return (
    <div
      className="pointer-events-auto flex items-start gap-2 rounded border border-l-4 border-line border-l-line-strong bg-surface-2 px-3 py-2 shadow-lg"
      data-testid="autovacuum-toast"
    >
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs">{actionTitle(notice.action)}</p>
        {actionReasons(notice.action).map((reason) => (
          <p key={reason} className="text-xs text-fg-muted">
            {reason}
          </p>
        ))}
      </div>
      <button
        type="button"
        className="icon-btn -mt-0.5 -mr-1 text-xs"
        onClick={() => onDismiss(notice.id)}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
