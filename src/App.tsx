import type { PGliteInterface } from '@electric-sql/pglite'
import type { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { loadCatalog, postgresVersion, type DatabaseInfo } from './db/catalog'
import { connectToDatabase } from './db/client'
import type { Plan } from './db/plan'
import { runAll, runStatementAt, type StatementResult } from './db/runner'
import { SEED_VERSION, readSeedInfo, resetDatabase, type SeedInfo } from './db/seed'
import { SqlEditor, selectInEditor, type RunMode } from './editor/SqlEditor'
import { APP_NAME, Header } from './layout/Header'
import { Workspace } from './layout/Workspace'
import { PlanTree } from './plan/PlanTree'
import { ResultsPane } from './results/ResultsPane'
import { SchemaBrowser } from './schema/SchemaBrowser'
import { readSetting, saveSetting } from './storage'

// Started once per page load: in development, React's StrictMode runs effects twice.
let connection: Promise<PGliteInterface> | undefined
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
  | { status: 'done'; results: StatementResult[]; sql: string }

/** Where the editor's text is kept between visits (localStorage, like the other UI settings). */
const EDITOR_TEXT_KEY = 'editor-text'

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
    if (view === null || state.status !== 'ready' || run.status === 'running') return
    const sql = view.state.doc.toString()
    const cursor = view.state.selection.main.head
    setRun({ status: 'running' })
    try {
      const db = await getDatabase()
      const results = mode === 'all' ? await runAll(db, sql) : await runStatementAt(db, sql, cursor)
      setRun({ status: 'done', results, sql })
    } catch (error) {
      // Postgres errors are results; this is the database connection itself failing.
      setRun({ status: 'idle' })
      setState({ status: 'error', message: String(error) })
      return
    }
    // The statement may have changed the schema (or the seed version), so reload them.
    // A failed transaction makes every query fail until ROLLBACK; then keep what's shown.
    try {
      setState({ status: 'ready', overview: await loadOverview() })
    } catch {
      // Refreshed after the next statement instead.
    }
  }

  function showPosition(position: number) {
    if (editorView.current) selectInEditor(editorView.current, position)
  }

  async function reset() {
    if (!window.confirm('Reset the database? Your indexes, tables and data changes will be lost.')) return
    setState({ status: 'resetting' })
    setRun({ status: 'idle' })
    try {
      await resetDatabase(await getDatabase())
      setState({ status: 'ready', overview: await loadOverview() })
    } catch (error) {
      setState({ status: 'error', message: String(error) })
    }
  }

  const overview = state.status === 'ready' ? state.overview : null
  const seedOutdated = overview !== null && overview.seed?.version !== SEED_VERSION
  const canRun = state.status === 'ready' && run.status !== 'running'
  // The plan of the last query in the run, if any.
  const plan: Plan | null =
    run.status === 'done'
      ? (run.results.flatMap((result) => (result.status === 'rows' && result.plan ? [result.plan] : [])).at(-1) ?? null)
      : null

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
              <SchemaBrowser database={overview.catalog} />
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
            plan ? (
              <PlanTree plan={plan} />
            ) : (
              <Placeholder>{planPlaceholder(run)}</Placeholder>
            )
          }
          visualization={
            <Placeholder comingSoon>
              Index pages, shared buffers and heap pages, animated one step at a time as the query runs.
            </Placeholder>
          }
          results={
            run.status === 'done' && run.results.length > 0 ? (
              <ResultsPane results={run.results} sql={run.sql} onShowPosition={showPosition} />
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
    </div>
  )
}

function planPlaceholder(run: RunState) {
  if (run.status === 'running') return 'Running…'
  if (run.status === 'done') return 'The last run had no query to plan. Run a SELECT to see the plan Postgres picks for it.'
  return 'Run a SELECT to see the plan Postgres picks, with estimated and actual rows for each step.'
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

function Placeholder({ comingSoon = false, children }: { comingSoon?: boolean; children: ReactNode }) {
  return (
    <div className="p-4 text-fg-muted">
      <p>{children}</p>
      {comingSoon && <p className="mt-1 text-xs uppercase tracking-wide">Coming soon</p>}
    </div>
  )
}
