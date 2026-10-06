# Vision

A browser-based sandbox that shows, one step at a time, what PostgreSQL actually does when it runs a query: which index pages it walks, which table pages it pulls from disk into memory, which rows pass or fail each condition, and how the result set builds up.

Inspired by Markus Winand's *SQL Performance Explained*. The book explains the mechanics in prose and diagrams; this app lets a learner run a query and watch those mechanics happen on real data.

## Audience

Developers who already write SQL but have never looked under the hood: the book's audience. The app uses real Postgres vocabulary (heap, page/block, `ctid`, B-tree root/internal/leaf, shared buffers, Index Cond vs. Filter) and explains every term with a glossary tooltip and a one-sentence caption per animation step. A **show internals** toggle reveals deeper detail (line pointers, tuple headers, `xmin`/`xmax`) for learners who want it.

## Principles

1. **Truthful.** Every plan, page number, `ctid`, index key, row count, and cache hit/read shown comes from a real Postgres instance. Postgres does not emit a per-row execution log, so the *order* of steps is reconstructed by our replay engine, and that reconstruction is checked against Postgres's own results and `EXPLAIN ANALYZE` counts. When the check fails, the app says so. See [ADR 0004](decisions/0004-pglite-plus-replay-engine.md).
2. **Digestible.** One action per step, plain-language captions, consistent colors with fixed meanings, and only the pages that matter shown in detail.
3. **Short.** A query animation finishes in about 30 seconds at normal speed, however much data it touches. Repetitive stretches are condensed (never invented or dropped) and can be expanded to full detail.
4. **Free and serverless.** The whole database runs in the visitor's browser; the site is static files on GitHub Pages.

## Product shape

- A free-form SQL sandbox: the editor runs any SQL (DDL, DML, queries) against a real Postgres database seeded with an online-store dataset ([DATA.md](DATA.md)).
- An **Examples** menu of ready-made queries, each demonstrating one concept from the book.
- Guided challenges ("make this query use an Index Only Scan") come later; the layout leaves room for a problem-statement panel.

Release scope (v1 / v2 / v3) lives in [ROADMAP.md](ROADMAP.md).

## Non-goals (for now)

- Databases other than PostgreSQL. The trace format and visualization stay engine-agnostic so others can be added later.
- Mobile layouts. The app is desktop-first; small screens get a "best on desktop" notice.
- Accounts, server-side storage, analytics, or tracking.
- Performance benchmarking. PGlite's "disk" lives in browser memory, so timings are not meaningful; the app shows what Postgres *does*, not how long real hardware takes.

## Known fidelity limits

PGlite runs Postgres as a single process, so:

- There are no parallel query plans (`Gather`), and no concurrent sessions.
- There is no autovacuum. The app simulates it ([ADR 0014](decisions/0014-simulated-autovacuum.md)).
