# Architecture

A static single-page app. All database work happens in the visitor's browser, inside a Web Worker running [PGlite](https://pglite.dev) (PostgreSQL 18 compiled to WebAssembly). The main thread renders, and prepares and decodes what it sends to Postgres.

```
┌──────────────────────── Main thread (React) ────────────────────────┐
│ Schema browser · SQL editor · Plan tree · Visualization · Results   │
│                         ▲                                           │
│                 Player (trace, position, speed, condensing)         │
│ Statement runner (split, classify, decode Postgres's replies)       │
│ Autovacuum simulator (after each run)                               │
│ Inspector  (reads real heap / B-tree pages and cache state)         │
│ Replay engine (re-walks the real plan over real pages → trace)      │
│ Validator  (replay vs. real result and EXPLAIN ANALYZE counts)      │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ queries and replies (PGlite's worker proxy)
┌─────────────────────────▼──────── Web Worker ───────────────────────┐
│ PGlite (Postgres 18.3)                                              │
│   + pageinspect, pg_buffercache                                     │
│   + IndexedDB persistence                                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Why a replay engine

Postgres exposes *what* happened (the plan, the result, and per-node totals in `EXPLAIN (ANALYZE, BUFFERS)`) and *where data lives* (`ctid`, `pageinspect`, `pg_buffercache`), but not a per-row log of the executor's actions. The replay engine produces that log by walking the real plan tree over the real pages, the same way Postgres's executor does. The decision and alternatives are in [ADR 0004](decisions/0004-pglite-plus-replay-engine.md).

## Running a SELECT

The order matters for getting buffer hits and reads exactly right; the measurements behind it are in [ADR 0022](decisions/0022-replay-pipeline-placement-and-buffer-counts.md).

1. **Plan.** Run a plain `EXPLAIN (BUFFERS, SUMMARY, VERBOSE, FORMAT JSON)`. The planner reads pages of its own (an index's metapage, and index probes for ranges near a column's minimum or maximum); doing it now keeps those reads out of the replay. The plan names the tables the query reads (a view shows up as the tables underneath); those tables and all their indexes are **the query's relations**. Temporary tables are left out: they live in the session's own buffers, not shared buffers.
2. **Empty the cache.** If **Empty cache** is on, evict every page of the query's relations (`pg_buffercache_evict_relation`), then plan again: on an empty cache the planner has to read its index probes again, as it would in a real run. The plan view shows the buffer counts of this last planning, since `EXPLAIN ANALYZE` plans once more and finds everything already cached.
3. **Snapshot the cache.** Record which pages of the query's relations are cached (`pg_buffercache`), in every fork. The replay decides hit or read from this.
4. **Execute.** Run `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`. This gives the real plan tree, estimated vs. actual rows per node, and real buffer hits and reads.
5. **Get the result.** Run the query itself for the result rows, then snapshot the cache again: this is what the query leaves behind.
6. **Inspect.** Read the pages the plan touches: B-tree root-to-leaf paths and leaf pages (`bt_page_items`; posting lists from B-tree deduplication included), and heap pages (`heap_page_items`). Pages are fetched lazily, in batches, and memoized for the run.
7. **Replay.** Walk the plan tree and emit a trace (below).
8. **Validate.** Compare the replay with steps 4 and 5 (see Validator).
9. **Restore the cache.** Inspection reads pages through shared buffers too. Evict each buffer that wasn't in the second snapshot (`pg_buffercache_evict`), so the next run sees exactly the cache this query left behind.

Other statements (DDL, DML, `ANALYZE`, `VACUUM`) just run. After each run (one statement or Run all), the autovacuum simulator checks thresholds, then the schema browser and page views refresh.

## Components

### Statement runner (main thread)
`src/db/statements.ts` and `src/db/runner.ts`; the decisions are in [ADR 0020](decisions/0020-statement-runner.md).

- **Splitting:** the editor text is split at semicolons the way psql does it (not inside strings, quoted identifiers, dollar quotes or comments). `Cmd/Ctrl+Enter` runs the statement under the cursor, or the one before it when the cursor sits between statements. **Run all** runs them in order and stops at the first error; the rest are reported as not run.
- **Classifying:** a statement that only reads (SELECT, WITH, VALUES or TABLE with no INSERT, UPDATE, DELETE, MERGE or INTO in it) goes through the pipeline above. Anything else runs once, as typed, without a plan, so writes never happen twice.
- **Sending:** each statement goes to Postgres with the simple query protocol, as psql sends it, and the reply is decoded on the main thread. PGlite's worker proxy would otherwise drop an error's position, DETAIL and HINT. Values are kept as Postgres's text (no conversion to JavaScript dates or objects), and notices are kept. The rest of the app's queries (catalog, autovacuum, seed info, and the pipeline's) go the same way, through `query()` in `src/db/query.ts`, which turns values into JavaScript values as `db.query` would. Nothing on the main thread calls `db.query` or `db.exec`: in the browser each of those waits for a save ([ADR 0023](decisions/0023-save-once-per-run.md)).
- **Results** are capped at 1,000 displayed rows (the total count is always reported). After each run the catalog (schema browser and editor completion) and the seed version are reloaded.

### Inspector (main thread)
`src/db/inspector.ts`: typed wrappers around `pageinspect` and `pg_buffercache`. Like the statement runner, it sends queries with `execProtocolRaw`, and reads pages in batches, one or two queries however many pages: each query through the worker proxy costs about a millisecond on top of Postgres's own work ([ADR 0022](decisions/0022-replay-pipeline-placement-and-buffer-counts.md)).

- **Relations:** the query's tables and their indexes, with their sizes in pages (`findRelations`).
- **Cache:** evict relations (`evictRelations`), snapshot which of their pages are cached, by fork (`snapshotCache`), and put the cache back as a snapshot had it by evicting what was loaded since (`restoreCache`, step 9).
- **Heap pages:** each line pointer and its tuple header (state, `xmin`, `xmax`, `t_ctid`, infomask) via `heap_page_items`.
- **B-tree pages:** the metapage (`bt_metap`), and each page's level, flags, left and right neighbors (`bt_page_stats`) and items (`bt_page_items`): high keys, downlinks to child pages, and leaf entries with the heap rows they point at, posting lists included.

Not yet: decoding index keys. The plan is to decode them from raw bytes for simple fixed-width types (int, bigint, date, timestamp), and for other types read the key from the heap row the index entry points to, evaluating the index's column expressions in SQL.

### Replay engine (main thread)
One replayer per plan node type. Each mirrors the executor's demand-pull iterator model (each node pulls rows from its children one at a time), written as TypeScript generators so v2 joins compose naturally. Replayers emit trace events and pass rows to their parent.

Buffer accesses follow the executor: a page access is a hit if the page was in the snapshot (step 3) or was already read earlier in this run, and a read otherwise. An index scan keeps its heap page pinned while consecutive index entries point into it, and only counts an access when it moves to another page. Index scans never read the B-tree metapage during execution (Postgres keeps it in memory after planning). Planning's own reads are not animated; the plan view reports them as a note.

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

### Validator (main thread)
Checks that the replay matches reality:

- The emitted rows equal the real result (as a multiset, or in order when the query has `ORDER BY`).
- Per-node actual rows and loops equal `EXPLAIN ANALYZE`.
- Buffer hits and reads equal `EXPLAIN (BUFFERS)`.

On mismatch the UI shows a warning banner but still plays the animation. Every example query has an automated test asserting a match.

### Player (main thread)
Holds the trace and the playback position. Supports play/pause, step forward and back, a timeline scrubber, speed control, and "jump to next row / page / plan node".

- **Condensing.** A condensing pass groups repetitive runs of real events into **stretches** so a run fits the ~30 s budget at normal speed ([ADR 0005](decisions/0005-realistic-data-and-30s-budget.md)).
- **Lazy detail.** Stretch summaries carry exact counts. Their full detail is computed only when a stretch is expanded. This keeps a 200,000-row Seq Scan cheap.

### Autovacuum simulator (main thread)
`src/db/autovacuum.ts`; the decisions are in [ADR 0014](decisions/0014-simulated-autovacuum.md) and [ADR 0021](decisions/0021-autovacuum-simulator.md).

PGlite has no autovacuum. After each run, unless the visitor is inside a transaction block:

1. **Flush the counters.** `SELECT pg_stat_force_next_flush()`. PGlite never runs the timer a real server uses to publish a session's pending counts, so without it recent writes can be missing from `pg_stat_user_tables`.
2. **Read** each table's `n_dead_tup`, `n_ins_since_vacuum` and `n_mod_since_analyze`, its `reltuples`, `relpages` and `relallfrozen`, its storage parameters, and the `autovacuum_*` settings.
3. **Decide** as Postgres 18's `relation_needs_vacanalyze` does. With the default settings: vacuum when dead rows > 50 + 20% of `reltuples` (capped at `autovacuum_vacuum_max_threshold`), or rows inserted since the last vacuum > 1,000 + 20% of the not-yet-frozen rows; analyze when rows changed since the last analyze > 50 + 10%.
4. **Act:** `VACUUM`, `ANALYZE`, or both as one `VACUUM (ANALYZE)`, and show a toast saying which counter crossed which threshold.

The **Autovacuum** checkbox in the editor toolbar turns it off. The schema browser reads the same counters (`loadCatalog` flushes first) to show how fresh each table's statistics are.

### Persistence and seeding (worker)
The database is stored in the browser's IndexedDB (PGlite data dir `idb://sql-execution-visualizer`). With several tabs open, PGlite elects one tab's worker to run Postgres and the others forward queries to it.

- **First load:** the worker's `init` generates the seed data in SQL from a fixed random seed, flushes the statistics counters, then `VACUUM ANALYZE`s it (about a second, so no prebuilt data directory is needed). The seed runs in one transaction, so an interrupted seed leaves nothing behind.
- **Saving:** PGlite saves the database to IndexedDB after each query by default, and makes the query wait about 40 ms for it. The pages' queries skip that: the worker hands PGlite's proxy the database wrapped by `saveWhenAsked` (`src/db/saveWhenAsked.ts`). Instead, the app saves once at the end of each run, after the autovacuum simulator and the catalog reload, and waits for it; **Run** is enabled again only after that, so a reload then keeps every change. **Reset database** is saved once, when complete. Seeding runs in the worker on the database itself, so it saves after every query ([ADR 0023](decisions/0023-save-once-per-run.md)).
- **Seed version:** stored in `visualizer.seed_info`, a schema of its own outside `public`. When a release bumps `SEED_VERSION`, the UI offers a reset instead of resetting on its own.
- **Reset database:** drops every non-system schema (including `public`, which takes `pageinspect` and `pg_buffercache` with it), recreates `public` and the extensions, and seeds again. Pages and `ctid`s come out identical to a first load; transaction IDs (`xmin`) are higher.
- **UI settings** (theme, pane sizes) are not in the database: they live in `localStorage`, read and written through `src/storage.ts`, which ignores storage errors so a browser that blocks site data still works, just without remembering them. Reset database leaves them alone.

## Hosting and delivery

`vite build` produces static files, deployed to GitHub Pages under `/sql-execution-visualizer/` by GitHub Actions on every push to `main` ([ADR 0012](decisions/0012-github-pages-hosting.md)).

## Testing

- **Vitest (Node):** PGlite runs in Node, so the worker pipeline (runner, inspector, replay, validator) is tested without a browser. Each example query must replay and validate cleanly.
- **Playwright:** tests load the production build in Chromium and do what a visitor does: first visit, reload, several tabs, reset, and running statements in the SQL editor (results, plans, errors, and changes surviving a reload). Each Playwright test gets a fresh browser profile, so each starts with an empty IndexedDB.
- Unit tests run in Node, so `tsconfig.node.json` typechecks them; browser code is typechecked without Node's types.
- Every PR adds tests for the behavior it adds and lists in its description what is not tested yet ([ADR 0018](decisions/0018-tests-in-every-pr.md)).

## Risks and open questions

- **Hosting headers.** GitHub Pages cannot set custom HTTP headers. PGlite is expected not to need any (no `SharedArrayBuffer`); M0 verifies this. Fallback: Cloudflare Pages.
- **Saving.** Changes are saved when a run ends, not after each statement, so closing the tab in the middle of a run can lose that run's changes ([ADR 0023](decisions/0023-save-once-per-run.md)). `saveWhenAsked` depends on which methods PGlite's worker proxy runs queries with; a PGlite upgrade that adds one would bring back a save per query (slower, not wrong).
- **Ring buffers.** A Seq Scan of a table larger than a quarter of shared buffers (4,096 pages in PGlite) uses a small ring of buffers, which the replay does not model. No seed table comes close; the validator flags a learner's table that does.
- **Volatile queries.** Steps 4 and 5 execute the query twice. Queries with `random()`, `now()`, etc. may differ between executions; the validator will flag them.
- **Autovacuum counters.** PGlite keeps `pg_stat_user_tables` up to date, but only publishes a session's counts when forced or a second after the last flush, and starts them from zero on every page load. The simulator forces a flush before reading, and accepts the reset, as after a crash on a real server ([ADR 0021](decisions/0021-autovacuum-simulator.md)).
- **Other databases.** MySQL/MariaDB have no maintained browser build. Supporting them later may require a different engine approach; the engine-agnostic trace and visualization keep that option open.
