# 0004: Real Postgres in the browser (PGlite) plus our own replay engine

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
The app must stay true to what Postgres does, show execution one row or page at a time, and be hostable for free as static files. Postgres has no API that emits a per-row execution log: `EXPLAIN ANALYZE` reports only per-node totals (rows, loops, timing, buffers). Any step-by-step animation is therefore a reconstruction.

## Decision
Use [PGlite](https://pglite.dev) (Postgres 18.3 compiled to WebAssembly, ~3 MB gzipped) in a Web Worker as the source of truth for:

- the plan
- the result
- physical layout (`ctid`, heap pages, B-tree pages via `pageinspect`)
- the page cache (`pg_buffercache`)

A TypeScript **replay engine** walks the real plan over the real pages to produce the step trace. Filter and Index Cond evaluation is delegated back to Postgres via helper queries. A **validator** checks the replay against the real result and the `EXPLAIN (ANALYZE, BUFFERS)` counts; a mismatch shows a warning banner. Details: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Consequences
- Every page number, `ctid`, key, plan choice, and count is real; only step ordering is reconstructed, and it is verified.
- No server, so free static hosting works.
- Each plan node type needs its own replayer.
- PGlite is single-process: no parallel plans, no concurrent sessions, no autovacuum (see [0014](0014-simulated-autovacuum.md)).
- Verified on 2026-10-05 with PGlite 0.5.8:
  - `pageinspect` (`bt_metap`, `bt_page_items`, `heap_page_items`) and `pg_buffercache` (including `pg_buffercache_evict*`) work.
  - On a 10,000-row table the planner chose Index Scan for selective predicates and Seq Scan for a ~1/30 predicate, without forcing.

## Alternatives considered
- **Our own toy engine in TypeScript:** simple to animate, but plans wouldn't match Postgres, which violates the core requirement.
- **A custom PGlite build with executor tracing in C:** the truest trace, but means maintaining C patches and a WebAssembly toolchain across Postgres releases. Kept open as a future upgrade: it could emit the same trace format.
- **A hosted Postgres server:** not free, and shared state between visitors.
