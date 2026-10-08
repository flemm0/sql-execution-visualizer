import type { PGliteInterface } from '@electric-sql/pglite'
import { useEffect, useState } from 'react'
import { listTables, postgresVersion, type TableInfo } from './db/catalog'
import { connectToDatabase } from './db/client'
import { SEED_VERSION, readSeedInfo, resetDatabase, type SeedInfo } from './db/seed'

// Started once per page load: in development, React's StrictMode runs effects twice.
let connection: Promise<PGliteInterface> | undefined
function getDatabase() {
  connection ??= connectToDatabase()
  return connection
}

interface Overview {
  version: string
  seed: SeedInfo | null
  tables: TableInfo[]
}

async function loadOverview(): Promise<Overview> {
  const db = await getDatabase()
  return {
    version: await postgresVersion(db),
    seed: await readSeedInfo(db),
    tables: await listTables(db),
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

  return (
    <main className="page">
      <header>
        <h1>SQL Execution Visualizer</h1>
        <p className="subtitle">Milestone 1 in progress: the sample online-store database, saved in your browser.</p>
      </header>

      {state.status === 'loading' && (
        <p className="muted">Starting Postgres… The first visit also generates the sample data.</p>
      )}
      {state.status === 'resetting' && <p className="muted">Resetting the database…</p>}
      {state.status === 'error' && <p className="error">Something went wrong: {state.message}</p>}
      {state.status === 'ready' && <Overview overview={state.overview} onReset={reset} />}

      <footer className="muted">
        <a href="https://github.com/flemm0/sql-execution-visualizer">Source on GitHub</a>
      </footer>
    </main>
  )
}

function Overview({ overview, onReset }: { overview: Overview; onReset: () => void }) {
  const outdated = overview.seed?.version !== SEED_VERSION
  return (
    <>
      {outdated && (
        <section className="card accent-heap" data-testid="seed-outdated">
          <p>
            This release ships new sample data. Reset the database to get it (your changes will be lost), or
            keep working with your current data.
          </p>
        </section>
      )}

      <section className="card">
        <p className="mono" data-testid="pg-version">
          {overview.version}
        </p>
        {overview.seed && (
          <p className="muted" data-testid="seeded-at">
            Sample data generated {overview.seed.seededAt.toLocaleString()} and saved in this browser.
          </p>
        )}
        <p>
          <button type="button" onClick={onReset}>
            Reset database
          </button>
        </p>
      </section>

      {overview.tables.map((table) => (
        <section className="card accent-heap" key={table.name} data-testid={`table-${table.name}`}>
          <h2>
            <code>{table.name}</code>
          </h2>
          <p>
            {formatRows(table.estimatedRows)} · {table.pages.toLocaleString()} heap pages ·{' '}
            {formatBytes(table.sizeBytes)}
          </p>
          <ul>
            {table.indexes.map((index) => (
              <li key={index.name}>
                <code className="index-name">{index.name}</code>: {index.pages.toLocaleString()} pages
                {index.levels !== null && `, ${index.levels} ${index.levels === 1 ? 'level' : 'levels'}`}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function formatRows(rows: number) {
  return rows < 0 ? 'not analyzed yet' : `~${Math.round(rows).toLocaleString()} rows`
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
