import type { PGliteInterface } from '@electric-sql/pglite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readIndexPage, readTablePage, type IndexPageView, type TablePageView } from '../db/pageBrowser'
import type { TableName } from '../db/plan'

/**
 * The page the visualization pane shows when a table or index is opened from
 * the schema browser.
 * - table: a heap page, with one row (line pointer) highlighted when it was
 *   opened from an index entry pointing at it.
 * - index: a B-tree page (null for the root), and the pages visited before it,
 *   most recent last, for Back.
 */
export type PageTarget =
  | { kind: 'table'; table: TableName; block: number; highlight: number | null }
  | { kind: 'index'; table: TableName; index: string; block: number | null; history: number[] }

export type PageViewData = TablePageView | IndexPageView

/** The page read from Postgres; while the next one loads, the last one stays on screen. */
export type PageViewState =
  | { status: 'loading'; view: PageViewData | null }
  | { status: 'ready'; view: PageViewData }
  | { status: 'error'; message: string }

export interface PageLoader {
  state: PageViewState
  /** Whether a page is being read now. Run waits meanwhile: two things never query the database at once. */
  loading: boolean
  /** Resolves when every read started so far has finished. */
  settled: () => Promise<void>
}

/**
 * Reads the target page from Postgres whenever the target changes, and again
 * when the database stops being busy (a run and its tidying up), so the page
 * shows what the run changed. Nothing is read while it's busy.
 */
export function usePageView(target: PageTarget | null, busy: boolean, getDatabase: () => Promise<PGliteInterface>): PageLoader {
  const [state, setState] = useState<PageViewState>({ status: 'loading', view: null })
  // A count, not a flag: a read whose result is no longer wanted still has to finish.
  const [pending, setPending] = useState(0)
  // Reads run one after another, chained on this promise. Each one never rejects.
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (target === null || busy) return
    // Cleared when the target changes again before this read finishes, so its result is dropped.
    let wanted = true
    async function read(target: PageTarget) {
      setPending((count) => count + 1)
      setState((previous) => ({ status: 'loading', view: previous.status === 'error' ? null : previous.view }))
      try {
        const db = await getDatabase()
        const view =
          target.kind === 'table'
            ? await readTablePage(db, target.table, target.block)
            : await readIndexPage(db, target.table, target.index, target.block)
        if (wanted) setState({ status: 'ready', view })
      } catch (error) {
        if (wanted) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        setPending((count) => count - 1)
      }
    }
    queue.current = queue.current.then(() => read(target))
    return () => {
      wanted = false
    }
  }, [target, busy, getDatabase])

  const settled = useCallback(() => queue.current, [])
  return { state, loading: pending > 0, settled }
}
