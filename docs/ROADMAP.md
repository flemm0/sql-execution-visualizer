# Roadmap

Each milestone ships as one or more PRs; merging to `main` deploys. A milestone is done when its exit criteria hold on the live site: `e2e/exit-criteria.spec.ts` states them as tests, and the **Live check** workflow runs it against the live site after every deploy ([ADR 0034](decisions/0034-exit-criteria-on-the-live-site.md)).

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
**Status:** done (2026-10-12): the exit criteria pass on the live site.

- Inspector, trace format, replay for **Seq Scan** and **Index Scan** (including Postgres 18 skip scan), validator.
- Visualization pane (index / shared buffers / heap zones, captions, mini-map), player controls, empty-cache toggle, results building up live.
- Page browser: a table's or index's pages, opened from the schema browser ([ADR 0032](decisions/0032-open-pages-from-the-schema-browser.md)).

**Exit:** examples 1, 2, 4 and 11 animate end-to-end and validate in tests.

### M3: rest of v1
**Status:** done (2026-10-14): the exit criteria pass on the live site. Index Only Scan (example 9), Bitmap Index Scan + Bitmap Heap Scan (examples 3, 6 and 12), and Sort and Limit, with backward index scans (example 10), replay; example 5 needed neither (an Index Scan and a Seq Scan). Examples 7 and 8 replay too: example 7's expression index needed index conditions on expressions; example 8 is a bitmap scan and a Seq Scan. Show internals is in ([ADR 0039](decisions/0039-show-internals.md)). Glossary tooltips are in ([ADR 0040](decisions/0040-glossary-tooltips.md)). All 12 examples are in the **Examples** menu, each checked against the plan Postgres picks ([ADR 0041](decisions/0041-examples-menu.md)); the exit criteria run every one from the menu. Condensing is in: every example plays in at most 900 steps, 30 s at the default speed, with expandable stretches ([ADR 0042](decisions/0042-condensed-steps-over-the-trace.md)). Jump-to-next controls are in: Next row, page and node ([ADR 0043](decisions/0043-jump-to-next.md)). The polish was hover info on the buffer slots and the heap mini-map ([ADR 0044](decisions/0044-hover-info-on-slots-and-mini-map.md)).

- Replay for Index Only Scan, Bitmap Index Scan + Bitmap Heap Scan, Sort, Limit.
- Condensing with the ~30 s budget and expandable stretches; jump-to-next controls.
- All 12 examples in the **Examples** menu; show-internals toggle; glossary tooltips; polish: hover info on buffer slots and the mini-map.

**Exit:** all 12 examples animate within budget and validate in tests.

## v2: joins and intermediate results
Joins, aggregates, subqueries and CTEs, in four milestones. Each adds its examples ([DATA.md](DATA.md#example-queries-v2), 13 to 29) to the **Examples** menu, `src/examples.ts` and the exit criteria. Milestones are ordered so that each one reuses the node types and views the earlier ones built. Until its milestone, a plan with one of these nodes says "Animation isn't available yet for …", as it does now.

### M4: Nested Loop, Materialize, and more than one table on screen
**Status:** in progress. Nested Loop replays, with parameters and a Join Filter, and the validator checks across loops ([ADR 0047](decisions/0047-nested-loop-replay.md)); example 13 is in the **Examples** menu and validates in tests. Next: Materialize (example 15), example 14, the relation cards and detail area, the result tabs, and condensing by loop.

- Replay for **Nested Loop** (inner joins, with a Join Filter): the inner side runs again for each outer row, with that row's values as its parameters (`Index Cond: (customer_id = c.id)`), one loop each. Replay for **Materialize**: it stores its child's rows on the first loop and reads them back from memory after that, without asking for any pages.
- The visualization shows several tables ([ADR 0045](decisions/0045-several-tables-on-screen.md)). One card per scan node, always on screen, gives the table, a small mini-map and the loop count. The index, buffers and heap zones show the scan working at the current step, and a visitor can pin one. Buffer slots carry the query's alias for the table (`o·h212`). A join zone shows the outer row driving the inner scan. Issue #28's ctid thread is built here, inside the detail zones.
- Intermediate-result tabs in the Results pane ([ADR 0046](decisions/0046-intermediate-result-tabs.md)), first for **Sort** (v1's example 10 gets one) and **Materialize**.
- The validator checks across loops: rows × loops, Index Searches and buffers summed over every loop.
- Condensing handles repeated loops: a loop of the inner scan is a unit, and the first loops play event by event.

**Exit:** examples 13, 14 and 15 animate within budget and validate in tests. Example 10's Sort and example 15's Materialize show their rows in tabs.

### M5: Hash Join and aggregates
- Replay for **Hash** and **Hash Join**: the Hash reads its whole input into a hash table, then each outer row probes it. In-memory only (`Batches: 1`); a join that splits into batches says "not available yet".
- Replay for **Aggregate** (no GROUP BY) and **HashAggregate**: rows go into groups by key, and each group's values come from Postgres. In-memory only; an aggregate that spills to disk (`Disk Usage`) says "not available yet".
- A hash-table view in the node zone and in the Hash's and HashAggregate's tabs. How rows are drawn into buckets gets its own ADR. Postgres's own hash functions may give each row's bucket, asked of Postgres the way B-tree key comparisons are.

**Exit:** examples 16 to 20 animate within budget and validate in tests.

### M6: Merge Join and GroupAggregate
- Replay for **Merge Join**: both inputs arrive sorted by the join key, and the join walks them side by side. Duplicate inner keys make it mark its place and go back (mark and restore).
- Replay for **GroupAggregate**: groups arrive in key order, and each one is passed on as soon as the next key starts, so a Limit above it can stop the scan early.

**Exit:** examples 21 and 22 animate within budget and validate in tests.

### M7: subqueries, CTEs and bigger joins
- **InitPlan** (a subquery that runs once, its value used as a parameter) and **SubPlan** (a correlated subquery that runs once per outer row).
- **Nested Loop Semi Join** (`EXISTS`): the inner scan stops at the first match. Anti and outer joins come here too, if they need anything beyond the semi join.
- **Subquery Scan**, **CTE** and **CTE Scan**: a materialized CTE fills a store once, and the CTE Scan reads it, with its own tab. Postgres counts the CTE's buffer accesses in the CTE Scan's.
- Joins of three and four tables, each with a tab for every intermediate result it holds.

**Exit:** examples 23 to 29 animate within budget and validate in tests. All 29 examples are in the **Examples** menu, and the exit criteria pass on the live site.

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
