# Roadmap

Each milestone ships as one or more PRs; merging to `main` deploys. A milestone is done when its exit criteria hold on the live site.

## v1: single-table queries

### M0: foundations
- Docs, repo, MIT license.
- Vite + React + TypeScript scaffold; lint, typecheck, Vitest, and Playwright wired into CI.
- GitHub Pages deploy via GitHub Actions.
- A bare page that starts PGlite in a Web Worker, loads `pageinspect` and `pg_buffercache`, and prints real page data.

**Exit:** the live GitHub Pages URL shows Postgres 18 running in the browser with `pageinspect` output, and CI is green.

### M1: Postgres in the browser, no animation
- Seed data generator ([DATA.md](DATA.md)), IndexedDB persistence, seed versioning, **Reset database**.
- Five-pane layout, design tokens and both themes, display name.
- Schema browser, SQL editor (CodeMirror 6 with schema-aware autocomplete), run-statement / run-all, results pane, plan tree from `EXPLAIN (ANALYZE, BUFFERS)`.
- Autovacuum simulator ([ADR 0014](decisions/0014-simulated-autovacuum.md)).

**Exit:** a visitor can run any SQL, create and drop indexes, see the plan change, and reload without losing their changes.

### M2: replay engine and player
- Inspector, trace format, replay for **Seq Scan** and **Index Scan** (including Postgres 18 skip scan), validator.
- Visualization pane (index / shared buffers / heap zones, captions, mini-map), player controls, empty-cache toggle, results building up live.

**Exit:** examples 1, 2, 4 and 11 animate end-to-end and validate in tests.

### M3: rest of v1
- Replay for Index Only Scan, Bitmap Index Scan + Bitmap Heap Scan, Sort, Limit.
- Condensing with the ~30 s budget and expandable stretches; jump-to-next controls.
- All 12 examples in the **Examples** menu; show-internals toggle; idle page browsing; glossary tooltips; polish.

**Exit:** all 12 examples animate within budget and validate in tests.

## v2: joins and intermediate results
- Nested Loop, Hash Join (+ Hash), Merge Join, Materialize.
- Aggregate, HashAggregate, GroupAggregate.
- Subqueries and CTEs (Subquery Scan, CTE Scan, InitPlan/SubPlan parameters).
- Intermediate-result tabs in the Results pane; multi-table examples (3+ table joins).

## v3: writes and beyond
- Animated INSERT / UPDATE / DELETE: new row versions (MVCC), HOT updates, index inserts, page splits.
- Animated VACUUM.
- Other index types (hash, GIN, BRIN, GiST).
- Window functions.
- A deliberately tiny buffer pool to watch pages get evicted.

## Later
- Guided challenges with a problem-statement panel.
- Custom schemas.
- Other open-source relational databases.
