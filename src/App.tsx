import { useEffect, useState } from 'react'
import { connectToDatabase } from './db/client'
import { probeDatabase, type ProbeReport } from './db/probe'

// Started once per page load: in development, React's StrictMode runs effects twice.
let reportPromise: Promise<ProbeReport> | undefined
function loadReport() {
  reportPromise ??= connectToDatabase().then(probeDatabase)
  return reportPromise
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; report: ProbeReport }
  | { status: 'error'; message: string }

export default function App() {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let active = true
    loadReport().then(
      (report) => {
        if (active) setState({ status: 'ready', report })
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', message: String(error) })
      },
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <main className="page">
      <header>
        <h1>SQL Execution Visualizer</h1>
        <p className="subtitle">Milestone 0: a real Postgres engine running in your browser.</p>
      </header>

      {state.status === 'loading' && <p className="muted">Starting Postgres…</p>}
      {state.status === 'error' && <p className="error">Couldn't start Postgres: {state.message}</p>}
      {state.status === 'ready' && <Report report={state.report} />}

      <footer className="muted">
        <a href="https://github.com/flemm0/sql-execution-visualizer">Source on GitHub</a>
      </footer>
    </main>
  )
}

function Report({ report }: { report: ProbeReport }) {
  const { btree, heapPage0, lookup } = report
  return (
    <>
      <section className="card">
        <h2>Engine</h2>
        <p className="mono" data-testid="pg-version">
          {report.version}
        </p>
      </section>

      <section className="card accent-index">
        <h2>
          B-tree index <code>m0_demo_pkey</code>
        </h2>
        <p data-testid="btree-root">
          The root is index page {btree.rootPage}; the tree has {btree.levels} levels.
        </p>
      </section>

      <section className="card accent-heap">
        <h2>
          Heap page 0 of <code>m0_demo</code>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Line pointer</th>
              <th>Offset in page</th>
              <th>Length (bytes)</th>
              <th>ctid</th>
            </tr>
          </thead>
          <tbody>
            {heapPage0.map((item) => (
              <tr key={item.lp}>
                <td>{item.lp}</td>
                <td>{item.lpOff}</td>
                <td>{item.lpLen}</td>
                <td>{item.ctid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card accent-result">
        <h2>Primary-key lookup with an empty cache</h2>
        <p data-testid="lookup">
          {lookup.nodeType} using <code>{lookup.indexName}</code>: {lookup.sharedReadBlocks} pages read from
          disk, {lookup.sharedHitBlocks} cache hits.
        </p>
      </section>
    </>
  )
}
