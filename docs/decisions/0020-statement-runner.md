# 0020: How the SQL editor runs statements

- **Status:** Accepted
- **Date:** 2026-10-07

## Context
The SQL editor (M1) has to run whatever a visitor types and show Postgres's answer faithfully: rows, the plan, and errors with their position, DETAIL and HINT. The browser talks to Postgres through PGlite's `PGliteWorker`, a proxy for the PGlite instance in the Web Worker. Three things surfaced while building it:

- When a statement fails inside the worker, the proxy passes back only the error message. The position, DETAIL, HINT and SQLSTATE code are dropped.
- PGlite converts some values to JavaScript types (dates become `Date` objects in the browser's time zone, `json` becomes objects), so they no longer read as Postgres printed them.
- A query is executed twice, once under `EXPLAIN ANALYZE` for the plan and once for its rows ([ARCHITECTURE.md](../ARCHITECTURE.md#running-a-select)). For a statement that writes, the write would happen twice.

## Decision
- **Splitting** happens in the browser (`src/db/statements.ts`), the way psql does it: semicolons inside strings, quoted identifiers, dollar quotes and comments don't end a statement. `Cmd/Ctrl+Enter` runs the statement under the cursor; **Run all** runs them in order and stops at the first error.
- **Each statement is sent with the simple query protocol** (as psql sends it) through `execProtocolRaw`, and the reply bytes are decoded on the main thread (`src/db/runner.ts`). Errors keep every field, notices come along, and statements like `VACUUM` work.
- **Values stay as Postgres's text.** Every PGlite type parser is replaced with one that keeps the text; NULL stays null.
- **Only read-only queries run twice.** A statement gets a plan when it starts with SELECT, WITH, VALUES or TABLE and has no INSERT, UPDATE (other than `FOR UPDATE`), DELETE, MERGE or INTO. Everything else runs once, without a plan.
- **The plan** comes from `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`. Node headings follow Postgres's text EXPLAIN, and counters text EXPLAIN hides when zero are hidden too.
- Results show at most 1,000 rows plus the total ([ADR 0017](0017-small-defaults.md)). After every run the schema browser, completion and seed version are reloaded from the catalog.

## Consequences
- What the results pane shows matches psql, including error DETAIL and HINT, which are often the most useful part for a learner.
- `execProtocolRaw` skips PGlite's own query queue on the main thread. The app never runs two things at once from one tab (a run finishes before the catalog reloads), so nothing interleaves. Code that adds concurrent queries has to keep that true.
- A query's rows all travel to the main thread before the first 1,000 are kept: about a second for `SELECT * FROM order_items` (200,582 rows).
- Function bodies written as `BEGIN ATOMIC ... END` (unquoted semicolons) are split in the wrong places; `$$` bodies work.

## Alternatives considered
- **`db.exec` / `db.query` as they are:** simplest, but loses the error details and converts dates and JSON.
- **Our own message protocol to the worker** (running statements there and sending back plain objects): keeps everything, but means writing and maintaining a second RPC layer next to PGlite's multi-tab leader election.
- **Running EXPLAIN ANALYZE inside a transaction that is rolled back,** so writes could get a plan too: the visitor may already be inside their own transaction, and sequences don't roll back. Deferred until writes are animated (v3).
- **A cursor (`DECLARE` / `FETCH 1000` / `MOVE ALL`)** to send only the shown rows: faster for huge results, but cursors only take plain queries and need a transaction. Not needed at this data size.
