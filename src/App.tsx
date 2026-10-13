import type { PGliteInterface } from '@electric-sql/pglite'
import type { PGliteWorker } from '@electric-sql/pglite/worker'
import type { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AutovacuumToasts, type AutovacuumNotice } from './autovacuum/AutovacuumToasts'
import { runAutovacuum, type AutovacuumAction } from './db/autovacuum'
import { loadCatalog, postgresVersion, type DatabaseInfo } from './db/catalog'
import { connectToDatabase } from './db/client'
import { inTransaction, runAll, runStatementAt, type RowsResult, type StatementResult } from './db/runner'
import { SEED_VERSION, readSeedInfo, resetDatabase, type SeedInfo } from './db/seed'
import { SqlEditor, selectInEditor, type RunMode } from './editor/SqlEditor'
import { APP_NAME, Header } from './layout/Header'
import { Workspace } from './layout/Workspace'
import { PlanTree } from './plan/PlanTree'
import { nodeProgressAt, resultRowsAt } from './player/playback'
import { usePlayer } from './player/usePlayer'
import { ResultsPane, type Filling } from './results/ResultsPane'
import { SchemaBrowser } from './schema/SchemaBrowser'
import type { CatalogObject } from './schema/tree'
import { PageBrowser } from './visualization/PageBrowser'
import { Visualization } from './visualization/Visualization'
import { usePageView, type PageTarget } from './visualization/usePageView'
import { readSetting, saveSetting } from './storage'

// Started once per page load: in development, React's StrictMode runs effects twice.
let connection: Promise<PGliteWorker> | undefined
function getDatabase() {
  connection ??= connectToDatabase()
  return connection
}

interface Overview {
  version: string
  seed: SeedInfo | null
  catalog: DatabaseInfo
}

async function loadOverview(): Promise<Overview> {
  const db = await getDatabase()
  return {
    version: await postgresVersion(db),
    seed: await readSeedInfo(db),
    catalog: await loadCatalog(db),
  }
}

type State =
  | { status: 'loading' }
  | { status: 'resetting' }
  | { status: 'ready'; overview: Overview }
  | { status: 'error'; message: string }

/** The last Run: nothing yet, in progress, or its results along with the editor text they came from. */
type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  /** `id` counts runs, so each run's visualization starts a fresh player. */
  | { status: 'done'; results: StatementResult[]; sql: string; id: number }

/** Where the editor's text is kept between visits (localStorage, like the other UI settings). */
const EDITOR_TEXT_KEY = 'editor-text'
/** Remembers whether the autovacuum simulator is turned off ('off'); on unless turned off. */
const AUTOVACUUM_KEY = 'autovacuum'
/** Remembers whether "Start with an empty cache" is turned off ('off'); on unless turned off. */
const EMPTY_CACHE_KEY = 'empty-cache'
/** Remembers whether Show internals is turned on ('on'); off unless turned on. */
const SHOW_INTERNALS_KEY = 'show-internals'

const STARTING_SQL = `-- Press Cmd/Ctrl+Enter to run the statement under the cursor,
-- or Shift+Cmd/Ctrl+Enter to run them all.

SELECT * FROM orders WHERE id = 4242;

SELECT * FROM order_items WHERE product_id = 42;
`

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent)
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+'

export default function App() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const editorView = useRef<EditorView | null>(null)
  // True from a run's results until autovacuum, the catalog reload and the save after it are done.
  // Run stays disabled meanwhile, so two things never query the database at once (ADR 0020),
  // and once it's enabled again, the run's changes are saved (ADR 0023).
  const [tidyingUp, setTidyingUp] = useState(false)
  const [autovacuumOn, setAutovacuumOn] = useState(() => readSetting(AUTOVACUUM_KEY) !== 'off')
  const [emptyCacheOn, setEmptyCacheOn] = useState(() => readSetting(EMPTY_CACHE_KEY) !== 'off')
  const [showInternals, setShowInternals] = useState(() => readSetting(SHOW_INTERNALS_KEY) === 'on')
  const [notices, setNotices] = useState<AutovacuumNotice[]>([])
  const nextNoticeId = useRef(1)
  const nextRunId = useRef(1)
  // One player for the visualization and the results pane, so both show the same step.
  const player = usePlayer()
  // The table or index page the visualization pane shows instead of the animation, if one is open.
  const [pageTarget, setPageTarget] = useState<PageTarget | null>(null)
  const pages = usePageView(pageTarget, state.status !== 'ready' || run.status === 'running' || tidyingUp, getDatabase)

  // useCallback keeps the same function between renders, so each notice's
  // timer (which depends on it) isn't restarted every time App renders.
  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id))
  }, [])

  useEffect(() => {
    let active = true
    loadOverview().then(
      (overview) => {
        if (active) setState({ status: 'ready', overview })
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', message: String(error) })
      },
    )
    return () => {
      active = false
    }
  }, [])

  async function runSql(mode: RunMode) {
    const view = editorView.current
    if (view === null || state.status !== 'ready' || run.status === 'running' || tidyingUp) return
    const sql = view.state.doc.toString()
    const cursor = view.state.selection.main.head
    setRun({ status: 'running' })
    const db = await getDatabase()
    // A page being read finishes first: two things never query the database at once.
    await pages.settled()
    try {
      const options = { emptyCache: emptyCacheOn }
      const results = mode === 'all' ? await runAll(db, sql, options) : await runStatementAt(db, sql, cursor, options)
      setRun({ status: 'done', results, sql, id: nextRunId.current++ })
      const replay = lastQueryOf(results)?.replay
      player.load(replay?.status === 'replayed' ? replay.trace.events.length : 0)
      // A query to animate takes the visualization pane back; otherwise an open page stays, and is read again.
      if (replay?.status === 'replayed') setPageTarget(null)
      setTidyingUp(true)
    } catch (error) {
      // Postgres errors are results; this is the database connection itself failing.
      setRun({ status: 'idle' })
      setState({ status: 'error', message: String(error) })
      return
    }
    if (autovacuumOn) {
      try {
        showNotices(await autovacuum(db))
      } catch (error) {
        // The run itself worked; keep its results. The next run checks again.
        console.error('The autovacuum simulator failed:', error)
      }
    }
    // The statement may have changed the schema (or the seed version), so reload them.
    // A failed transaction makes every query fail until ROLLBACK; then keep what's shown.
    try {
      setState({ status: 'ready', overview: await loadOverview() })
    } catch {
      // Refreshed after the next statement instead.
    }
    await save(db)
    setTidyingUp(false)
  }

  function showNotices(actions: AutovacuumAction[]) {
    const added = actions.map((action) => ({ id: nextNoticeId.current++, action }))
    setNotices((current) => [...current, ...added])
  }

  function toggleAutovacuum(on: boolean) {
    setAutovacuumOn(on)
    saveSetting(AUTOVACUUM_KEY, on ? 'on' : 'off')
  }

  function toggleEmptyCache(on: boolean) {
    setEmptyCacheOn(on)
    saveSetting(EMPTY_CACHE_KEY, on ? 'on' : 'off')
  }

  function toggleInternals(on: boolean) {
    setShowInternals(on)
    saveSetting(SHOW_INTERNALS_KEY, on ? 'on' : 'off')
  }

  /** Opens a table's first page or an index's root, from the schema browser; the animation pauses meanwhile. */
  function openInPageBrowser(object: Extract<CatalogObject, { kind: 'table' | 'index' }>) {
    const table = { schema: object.table.schema, name: object.table.name }
    player.pause()
    setPageTarget(
      object.kind === 'table'
        ? { kind: 'table', table, block: 0, highlight: null }
        : { kind: 'index', table, index: object.index.name, block: null, history: [] },
    )
  }

  function showPosition(position: number) {
    if (editorView.current) selectInEditor(editorView.current, position)
  }

  async function reset() {
    if (!window.confirm('Reset the database? Your indexes, tables and data changes will be lost.')) return
    setState({ status: 'resetting' })
    setRun({ status: 'idle' })
    setPageTarget(null)
    try {
      const db = await getDatabase()
      await resetDatabase(db)
      // Saved only once it's complete, so a reset cut short by a reload leaves the old database.
      await save(db)
      setState({ status: 'ready', overview: await loadOverview() })
    } catch (error) {
      setState({ status: 'error', message: String(error) })
    }
  }

  const overview = state.status === 'ready' ? state.overview : null
  const seedOutdated = overview !== null && overview.seed?.version !== SEED_VERSION
  const canRun = state.status === 'ready' && run.status !== 'running' && !tidyingUp && !pages.loading
  // The last query in the run that has a plan, if any.
  const lastQuery = run.status === 'done' ? lastQueryOf(run.results) : undefined
  const trace = lastQuery?.replay?.status === 'replayed' ? lastQuery.replay.trace : null
  // While the animation plays, the query's result fills in as rows are emitted;
  // at the last step it's whole (even if the replay sent fewer rows than Postgres did).
  const filling: Filling | null =
    lastQuery && trace && player.position < player.steps ? { result: lastQuery, rows: resultRowsAt(trace, player.position) } : null
  // Likewise the plan tree highlights the node working now and counts each node's rows so far.
  const progress = trace && player.position < player.steps ? nodeProgressAt(trace, player.position) : null

  return (
    <div className="flex h-screen flex-col">
      <Header />

      <p className="border-b border-line bg-surface-2 px-4 py-1.5 text-fg-muted lg:hidden" data-testid="desktop-notice">
        {APP_NAME} is built for desktop screens. Widen the window to at least 1024 px for room to see every pane.
      </p>
      {seedOutdated && (
        <Banner accent="border-l-heap" testId="seed-outdated">
          This release ships new sample data. Reset the database to get it (your changes will be lost), or keep
          working with your current data.
        </Banner>
      )}
      {state.status === 'error' && (
        <Banner accent="border-l-rejected" testId="app-error">
          Something went wrong: {state.message}
        </Banner>
      )}

      <main className="min-h-0 flex-1">
        <Workspace
          schemaBrowser={
            overview ? (
              <SchemaBrowser database={overview.catalog} autovacuumOn={autovacuumOn} onOpen={openInPageBrowser} />
            ) : (
              <Placeholder>
                {state.status === 'resetting'
                  ? 'Resetting the database…'
                  : 'Starting Postgres… The first visit also generates the sample data.'}
              </Placeholder>
            )
          }
          editorToolbar={
            <>
              <button
                type="button"
                className="btn text-xs"
                onClick={() => runSql('statement')}
                disabled={!canRun}
                title={`Run the statement under the cursor (${MOD_KEY}Enter)`}
              >
                Run
              </button>
              <button
                type="button"
                className="btn text-xs"
                onClick={() => runSql('all')}
                disabled={!canRun}
                title={`Run every statement, in order (Shift+${MOD_KEY}Enter)`}
              >
                Run all
              </button>
              <button type="button" className="btn text-xs" onClick={reset} disabled={state.status !== 'ready'}>
                Reset database
              </button>
              <label
                className="ml-2 flex items-center gap-1.5 text-xs text-fg-muted"
                title="After each run, vacuum and analyze the tables that crossed Postgres's autovacuum thresholds, as a real server would within a minute. Turn off to study stale statistics."
              >
                <input type="checkbox" checked={autovacuumOn} onChange={(event) => toggleAutovacuum(event.target.checked)} />
                Autovacuum
              </label>
              <label
                className="flex items-center gap-1.5 text-xs text-fg-muted"
                title="Before each query, remove its tables' and indexes' pages from shared buffers, so every page it needs is read from disk. Turn off and run again to see buffer hits."
              >
                <input type="checkbox" checked={emptyCacheOn} onChange={(event) => toggleEmptyCache(event.target.checked)} />
                Empty cache
              </label>
            </>
          }
          editor={
            <SqlEditor
              initialText={readSetting(EDITOR_TEXT_KEY) ?? STARTING_SQL}
              database={overview?.catalog ?? null}
              onRun={runSql}
              onChange={(text) => saveSetting(EDITOR_TEXT_KEY, text)}
              viewRef={editorView}
            />
          }
          plan={
            lastQuery?.plan ? (
              <PlanTree plan={lastQuery.plan} replay={lastQuery.replay} progress={progress} />
            ) : (
              <Placeholder>{planPlaceholder(run)}</Placeholder>
            )
          }
          visualization={
            pageTarget ? (
              <PageBrowser
                target={pageTarget}
                state={pages.state}
                onOpen={setPageTarget}
                onBackToAnimation={trace ? () => setPageTarget(null) : null}
                internals={showInternals}
              />
            ) : run.status === 'done' && lastQuery?.plan && lastQuery.replay?.status === 'replayed' ? (
              <Visualization
                key={run.id}
                plan={lastQuery.plan}
                trace={lastQuery.replay.trace}
                validation={lastQuery.replay.validation}
                player={player}
                internals={showInternals}
              />
            ) : (
              <Placeholder>{visualizationPlaceholder(run, lastQuery)}</Placeholder>
            )
          }
          visualizationToolbar={
            <label
              className="flex items-center gap-1.5 text-xs text-fg-muted"
              title="Also show Postgres's bookkeeping, as it read it: line pointers and tuple headers (xmin, xmax, infomask) on heap pages, visibility map bits, and each B-tree page's high key."
            >
              <input type="checkbox" checked={showInternals} onChange={(event) => toggleInternals(event.target.checked)} />
              Show internals
            </label>
          }
          results={
            run.status === 'done' && run.results.length > 0 ? (
              <ResultsPane
                results={run.results}
                sql={run.sql}
                onShowPosition={showPosition}
                filling={filling}
                onSkipToEnd={() => player.seek(player.steps)}
              />
            ) : (
              <Placeholder>{resultsPlaceholder(run)}</Placeholder>
            )
          }
        />
      </main>

      <footer className="flex gap-4 border-t border-line bg-surface-1 px-4 py-1 font-mono text-xs text-fg-muted">
        {overview && (
          <>
            <span data-testid="pg-version">{overview.version}</span>
            {overview.seed && (
              <span data-testid="seeded-at">
                Sample data generated {overview.seed.seededAt.toLocaleString()}, saved in this browser
              </span>
            )}
          </>
        )}
      </footer>
      <AutovacuumToasts notices={notices} onDismiss={dismissNotice} />
    </div>
  )
}

/** The last query in a run that has a plan, if any: the one the plan and visualization panes show. */
function lastQueryOf(results: StatementResult[]): RowsResult | undefined {
  return results.filter((result): result is RowsResult => result.status === 'rows' && result.plan !== null).at(-1)
}

/**
 * Runs the autovacuum simulator after a run, unless the visitor is inside a
 * transaction block: VACUUM can't run there, and a real autovacuum worker
 * can't see uncommitted changes anyway. It runs once the transaction ends.
 */
async function autovacuum(db: PGliteInterface): Promise<AutovacuumAction[]> {
  if (await inTransaction(db)) return []
  return runAutovacuum(db)
}

/**
 * Saves the database to IndexedDB and waits until it's done. The app's queries
 * don't save on their own, so a read never waits for a save (ADR 0023).
 */
async function save(db: PGliteWorker) {
  try {
    await db.syncToFs()
  } catch (error) {
    // The run's results stand; the next run's save tries again.
    console.error('Saving the database failed:', error)
  }
}

function planPlaceholder(run: RunState) {
  if (run.status === 'running') return 'Running…'
  if (run.status === 'done') return 'The last run had no query to plan. Run a SELECT to see the plan Postgres picks for it.'
  return 'Run a SELECT to see the plan Postgres picks, with estimated and actual rows for each step.'
}

function visualizationPlaceholder(run: RunState, lastQuery: RowsResult | undefined) {
  if (run.status === 'running') return 'Running…'
  const replay = lastQuery?.replay
  if (replay?.status === 'unsupported') return `${replay.reason} The plan and the result are still real.`
  if (replay?.status === 'failed') return `The replay failed, so there’s nothing to animate: ${replay.message}`
  if (run.status === 'done') return 'The last run had no query to animate. Run a SELECT to watch Postgres run it.'
  return 'Run a SELECT to watch Postgres run it, one step at a time: the index pages it walks, the pages it reads into shared buffers, and the rows it checks and sends to the result. Or click a table or index in the schema browser to look through its pages.'
}

function resultsPlaceholder(run: RunState) {
  if (run.status === 'running') return 'Running…'
  if (run.status === 'done') return 'Nothing to run: the editor has no statements.'
  return 'Run a statement to see its result here.'
}

function Banner({ accent, testId, children }: { accent: string; testId: string; children: ReactNode }) {
  return (
    <p className={`border-b border-l-4 border-line bg-surface-2 px-4 py-2 ${accent}`} data-testid={testId}>
      {children}
    </p>
  )
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="p-4 text-fg-muted">
      <p>{children}</p>
    </div>
  )
}
