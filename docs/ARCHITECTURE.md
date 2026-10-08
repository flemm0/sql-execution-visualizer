# Architecture

A static single-page app. All database work happens in the visitor's browser, inside a Web Worker running [PGlite](https://pglite.dev) (PostgreSQL 18 compiled to WebAssembly). The main thread only renders.

```
┌──────────────────────── Main thread (React) ────────────────────────┐
│ Schema browser · SQL editor · Plan tree · Visualization · Results   │
│                         ▲                                           │
│                 Player (trace, position, speed, condensing)         │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ messages (statements, traces, page data)
┌─────────────────────────▼──────── Web Worker ───────────────────────┐
│ Statement runner ─► PGlite (Postgres 18.3)                          │
│                       + pageinspect, pg_buffercache                 │
│                       + IndexedDB persistence                       │
│ Inspector  (reads real heap / B-tree pages and cache state)         │
│ Replay engine (re-walks the real plan over real pages → trace)      │
│ Validator  (replay vs. real result and EXPLAIN ANALYZE counts)      │
│ Autovacuum simulator                                                │
└─────────────────────────────────────────────────────────────────────┘
```

## Why a replay engine

Postgres exposes *what* happened (the plan, the result, and per-node totals in `EXPLAIN (ANALYZE, BUFFERS)`) and *where data lives* (`ctid`, `pageinspect`, `pg_buffercache`), but not a per-row log of the executor's actions. The replay engine produces that log by walking the real plan tree over the real pages, the same way Postgres's executor does. The decision and alternatives are in [ADR 0004](decisions/0004-pglite-plus-replay-engine.md).

## Running a SELECT

1. **Prepare the cache.** If "start with an empty cache" is on, evict the buffers of every relation in the query (`pg_buffercache_evict_relation`). Snapshot which pages are cached (`pg_buffercache`).
2. **Plan and execute.** Run `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`. This gives the real plan tree, estimated vs. actual rows per node, and real buffer hits and reads.
3. **Get the result.** Run the query itself for the result rows.
4. **Inspect.** Read the pages the plan touches: B-tree metapage, root-to-leaf paths and leaf pages (`bt_metap`, `bt_page_items`; posting lists from B-tree deduplication included), and heap pages (`heap_page_items`). Pages are fetched lazily and memoized for the run.
5. **Replay.** Walk the plan tree and emit a trace (below).
6. **Validate.** Compare the replay with steps 2 and 3 (see Validator).
7. **Restore the cache.** Inspection reads pages through shared buffers too. Evict pages loaded only by inspection, so the next run sees exactly the cache this query left behind.

Other statements (DDL, DML, `ANALYZE`, `VACUUM`) just run; the schema browser and page views refresh, then the autovacuum simulator checks thresholds.

## Components

### Statement runner (worker)
Splits editor text into statements, runs the one under the cursor or all of them, classifies each (SELECT vs. other), and routes SELECTs through the pipeline above. Results are capped at 1,000 displayed rows (the total count is always reported).

### Inspector (worker)
Typed wrappers around `pageinspect` and `pg_buffercache`. Decodes index keys from raw bytes for simple fixed-width types (int, bigint, date, timestamp). For other types it reads the key from the heap row the index entry points to, evaluating the index's column expressions in SQL.

### Replay engine (worker)
One replayer per plan node type. Each mirrors the executor's demand-pull iterator model (each node pulls rows from its children one at a time), written as TypeScript generators so v2 joins compose naturally. Replayers emit trace events and pass rows to their parent.

Replayers never re-implement SQL semantics. Whether a row passes a `Filter` or `Index Cond` is asked of Postgres with a helper query built from the plan's deparsed expressions, e.g. `SELECT ctid FROM orders WHERE <filter>`, which returns the set of passing `ctid`s. Plans that reference parameters, subplans, or InitPlans are out of v1 scope.

Node types by release: see [ROADMAP.md](ROADMAP.md). A node without a replayer still shows its plan and result, with "animation not yet supported for X".

### Trace format
An ordered list of small, engine-agnostic events. Each has a type, the plan node it belongs to, the objects it touches, and a caption template with parameters. Illustrative types:

| Event | Meaning |
|---|---|
| `node.start` / `node.finish` | A plan node begins or ends work |
| `index.visit` | Read an index page at a given level; compare keys |
| `index.entry` | An index entry matched; it points at a `ctid` |
| `buffer.hit` / `buffer.read` | Page requested: already cached, or read from disk into a buffer |
| `heap.tuple` | Examine one row version: visible? passes the filter? |
| `row.emit` | Node passes a row to its parent (or to the client) |
| `sort.*`, `limit.stop` | Operator-specific steps |

Engine-specific code (Postgres runner, inspector, replayers) sits behind a `DatabaseEngine` interface. The trace, player, and visualization know nothing Postgres-specific beyond vocabulary, so other databases can be added later.

### Validator (worker)
Checks that the replay matches reality:

- The emitted rows equal the real result (as a multiset, or in order when the query has `ORDER BY`).
- Per-node actual rows and loops equal `EXPLAIN ANALYZE`.
- Buffer hits and reads equal `EXPLAIN (BUFFERS)`.

On mismatch the UI shows a warning banner but still plays the animation. Every example query has an automated test asserting a match.

### Player (main thread)
Holds the trace and the playback position. Supports play/pause, step forward and back, a timeline scrubber, speed control, and "jump to next row / page / plan node".

- **Condensing.** A condensing pass groups repetitive runs of real events into **stretches** so a run fits the ~30 s budget at normal speed ([ADR 0005](decisions/0005-realistic-data-and-30s-budget.md)).
- **Lazy detail.** Stretch summaries carry exact counts. Their full detail is computed only when a stretch is expanded. This keeps a 200,000-row Seq Scan cheap.

### Autovacuum simulator (worker)
PGlite has no autovacuum. After each write, read `pg_stat_user_tables` and apply Postgres's default autovacuum thresholds (analyze: 50 rows + 10% of the table changed; vacuum: 50 + 20% dead rows; insert-vacuum: 1,000 + 20% inserted). When crossed, run `ANALYZE` / `VACUUM` on that table and show a notice. A setting turns it off. See [ADR 0014](decisions/0014-simulated-autovacuum.md).

### Persistence and seeding (worker)
The database is stored in the browser's IndexedDB (PGlite data dir `idb://sql-execution-visualizer`). With several tabs open, PGlite elects one tab's worker to run Postgres and the others forward queries to it.

- **First load:** the worker's `init` generates the seed data in SQL from a fixed random seed, then `VACUUM ANALYZE`s it (about a second, so no prebuilt data directory is needed). The seed runs in one transaction, so an interrupted seed leaves nothing behind.
- **Seed version:** stored in `visualizer.seed_info`, a schema of its own outside `public`. When a release bumps `SEED_VERSION`, the UI offers a reset instead of resetting on its own.
- **Reset database:** drops every non-system schema (including `public`, which takes `pageinspect` and `pg_buffercache` with it), recreates `public` and the extensions, and seeds again. Pages and `ctid`s come out identical to a first load; transaction IDs (`xmin`) are higher.

## Hosting and delivery

`vite build` produces static files, deployed to GitHub Pages under `/sql-execution-visualizer/` by GitHub Actions on every push to `main` ([ADR 0012](decisions/0012-github-pages-hosting.md)).

## Testing

- **Vitest (Node):** PGlite runs in Node, so the worker pipeline (runner, inspector, replay, validator) is tested without a browser. Each example query must replay and validate cleanly.
- **Playwright:** tests load the production build in Chromium and do what a visitor does: first visit, reload, several tabs, reset, and, once the SQL editor exists, running queries. Each Playwright test gets a fresh browser profile, so each starts with an empty IndexedDB.
- Unit tests run in Node, so `tsconfig.node.json` typechecks them; browser code is typechecked without Node's types.
- Every PR adds tests for the behavior it adds and lists in its description what is not tested yet ([ADR 0018](decisions/0018-tests-in-every-pr.md)).

## Risks and open questions

- **Hosting headers.** GitHub Pages cannot set custom HTTP headers. PGlite is expected not to need any (no `SharedArrayBuffer`); M0 verifies this. Fallback: Cloudflare Pages.
- **Volatile queries.** Steps 2 and 3 execute the query twice. Queries with `random()`, `now()`, etc. may differ between executions; the validator will flag them.
- **Autovacuum counters.** The autovacuum simulator depends on `pg_stat_user_tables` counters being maintained in PGlite's single-process mode. A first check in M1 looks off: right after the seed's `VACUUM ANALYZE` plus 100 updates, `orders` reports `n_live_tup` 100,000 (twice the real count) and `n_mod_since_analyze` 50,000. To investigate in the autovacuum simulator PR (stats flushing, or counting from `pg_stat_user_tables` deltas ourselves).
- **Other databases.** MySQL/MariaDB have no maintained browser build. Supporting them later may require a different engine approach; the engine-agnostic trace and visualization keep that option open.
