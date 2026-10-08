import type { PGliteInterface } from '@electric-sql/pglite'
import { useEffect, useState, type ReactNode } from 'react'
import { loadCatalog, postgresVersion, type DatabaseInfo } from './db/catalog'
import { connectToDatabase } from './db/client'
import { SEED_VERSION, readSeedInfo, resetDatabase, type SeedInfo } from './db/seed'
import { APP_NAME, Header } from './layout/Header'
import { Workspace } from './layout/Workspace'
import { SchemaBrowser } from './schema/SchemaBrowser'

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

export default function App() {
  const [state, setState] = useState<State>({ status: 'loading' })

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

  async function reset() {
    if (!window.confirm('Reset the database? Your indexes, tables and data changes will be lost.')) return
    setState({ status: 'resetting' })
    try {
      await resetDatabase(await getDatabase())
      setState({ status: 'ready', overview: await loadOverview() })
    } catch (error) {
      setState({ status: 'error', message: String(error) })
    }
  }

  const overview = state.status === 'ready' ? state.overview : null
  const seedOutdated = overview !== null && overview.seed?.version !== SEED_VERSION

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
            <button type="button" className="btn text-xs" onClick={reset} disabled={state.status !== 'ready'}>
              Reset database
            </button>
          }
          editor={<Placeholder comingSoon>Write SQL here and run it against the sample store database.</Placeholder>}
          plan={<Placeholder comingSoon>The plan Postgres picked, with estimated and actual rows for each step.</Placeholder>}
          visualization={
            <Placeholder comingSoon>
              Index pages, shared buffers and heap pages, animated one step at a time as the query runs.
            </Placeholder>
          }
          results={<Placeholder comingSoon>Result rows, filling in as the query emits them.</Placeholder>}
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
