# 0047: Nested Loop replay: the inner side runs once per outer row, with its values bound as constants

- **Status:** Accepted
- **Date:** 2026-10-14

## Context
M4 ([ROADMAP.md](../ROADMAP.md#m4-nested-loop-materialize-and-more-than-one-table-on-screen)) starts with Nested Loop. Example 13 ([DATA.md](../DATA.md#example-queries-v2)) joins 38 customers to their orders: a bitmap scan finds the customers, and for each one the Nested Loop runs an Index Scan on orders whose Index Cond is `(o.customer_id = c.id)`. `c.id` is a parameter: the outer row's value, different in every loop. Until now every replay had one scan, run once, over one table.

From Postgres 18.3, measured in PGlite and read in its source (`nodeNestloop.c`, `explain.c`):

- The inner side is rescanned for every outer row (a loop). EXPLAIN writes the parameter as the outer table's column, `c.id`. `Inner Unique` (VERBOSE) says each outer row matches at most one inner row: the join moves on after the first match, without asking the inner side again. A `Join Filter` is checked on each pair the inner side returns.
- For a node that ran more than once, EXPLAIN reports `Actual Rows` as an average per loop, rounded to 2 decimals (example 13's inner scan: 5.18 over 38 loops, for 197 rows), and `Rows Removed by Filter` (and by Join Filter) as an average rounded to a whole number. `Index Searches`, `Heap Fetches`, `Exact Heap Blocks` and buffer counts are totals over every loop.
- An Index Only Scan keeps its visibility map page pinned from one loop to the next (`ExecReScanIndexOnlyScan` doesn't let go of it), so the map costs one buffer access in all, not one per loop. An Index Scan lets go of its heap page on a rescan.
- When two scans read the same table (a self-join, example 15), which of them reads a page and which finds it cached depends on the order they ask for it.

## Decision
- **Parameters become constants, from Postgres.** For each outer row, one query reads the values the inner side's conditions use, by ctid, written as constants of their type (`'4242'::integer`, from `quote_nullable` and `pg_typeof`). The replay puts them into the inner side's Index Cond and Filter (`params.ts`): `(o.customer_id = ('4242'::integer))`. From there the inner scan replays as any scan with a constant condition, walking the index, fetching rows, checking the Filter, all asked of Postgres as before. Loops with the same values share one replay. The trace keeps each loop's values for the captions (`join.loop`).
- **Each loop's walk of the index happens before the query runs**, as one scan's does ([ADR 0025](0025-index-scan-replay.md)): running the query can mark index entries dead. To know the values, `prepareReplay` replays the whole plan before the query runs when it has parameters (reading rows changes nothing), and keeps every walk, by scan and bound Index Cond. After the query, the replay uses those walks.
- **A row of a join is a row of each table.** `row.emit` carries `outer`, the outer side's rows, besides `row`, the inner side's. The result's values are read by joining each table by its own ctid, with the plan's output expressions; so are a Join Filter's results, one query for every pair.
- **Events are made in the executor's order, as they play.** Each node's queries run first; its events then come from a generator, asked for one at a time as the plan plays, so each page access is decided hit or read in the order the scans ask for it. Which rows a node passes up doesn't depend on the cache, so the replay learns them by playing it against empty buffers.
- **The validator checks across loops.** A count Postgres reports per loop is checked per loop: the replay's total divided by the loops, matching if it rounds to Postgres's number (the check says "per loop, of 38"). Totals are checked as totals. `Exact Heap Blocks` counts each page once per loop.
- **Trace events:** `join.loop` (a loop starts: its number, the outer row, the parameters' values) and `join.filter` (a pair checked, and whether it passes). The inner scan's own `node.start` and `node.finish` repeat in every loop.
- **Supported:** inner joins (`Nested Loop`, with or without a Join Filter, with or without Inner Unique but not both), over Seq Scan, Index Scan, Index Only Scan and Bitmap Heap Scan, and over other Nested Loops (joins of several tables). Not yet: a Sort or Limit above a join or inside one, outer, semi and anti joins (M7), Materialize (next in M4).
- **Before the layout of [ADR 0045](0045-several-tables-on-screen.md):** the visualization keeps v1's zones. The index zone shows whichever index the step's search is in, and the heap zone the page being read; the mini-map shows the first table the query reads, and no longer marks other tables' pages on it. Captions say which loop runs and with which values, and name the tables of a joined row.

## Consequences
- Example 13 replays and validates: 1,447 events, condensed into 887 steps.
- A plan with parameters is replayed twice, once before the query runs and once after: example 13 takes about 0.9 s in Node, where a single-table example takes about 0.5 s.
- Joins of several tables (example 28's shape) already replay; M7 needs only its other node types.
- A join with many loops can still exceed the step budget: each loop's search and index pages are steps of their own. Example 13's 38 loops fit; 200 don't. Condensing a loop into a unit is M4's later work.
- When two loops search for the same value and the first marks entries dead, the second, walked before the query, still sees them: the validator would flag it. No example does this.

## Alternatives considered
- **Walk each loop's index after the query runs:** simpler, no replay before the query, but a scan that marks entries dead would then miss them in its own replay, as ADR 0025 found for single scans.
- **Substitute the parameter's value as text the replay writes:** no query, but the replay would be formatting SQL values of any type itself; Postgres writing the constant keeps types and quoting right.
- **Make every node's events eagerly, outer side first:** what the replay did before. With one scan the order didn't matter; with a self-join, the outer scan would take reads that belong to the inner scan, or the other way round.
- **Check per-loop counts as `rows × loops`, rounded:** what the validator did before. Fine for 2 decimals and few loops, but wrong for Rows Removed by Filter (whole rows per loop) and for totals Postgres doesn't average (heap blocks, heap fetches).
