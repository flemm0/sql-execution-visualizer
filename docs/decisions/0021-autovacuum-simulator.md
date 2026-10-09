# 0021: How the autovacuum simulator reads counters and decides

- **Status:** Accepted
- **Date:** 2026-10-08

## Context
[ADR 0014](0014-simulated-autovacuum.md) chose to simulate autovacuum. It depended on PGlite keeping `pg_stat_user_tables` up to date, which looked wrong in M1: right after the seed, `orders` reported 100,000 live rows (twice the real count) and 50,000 rows changed since the last analyze. Investigating it in PGlite 0.5.8 (Postgres 18.3) found:

- **The counters work, but are flushed late.** Postgres counts a session's writes locally and adds them to the shared counters when the session goes idle, at most once a second. A real server sets a timer to flush whatever is left. PGlite never runs that timer, so a write is invisible until a statement arrives at least a second after the last flush. `SELECT pg_stat_force_next_flush()` flushes as soon as that statement ends.
- **The doubled counts were the seed's own fault.** The seed's 50,000 inserts were still pending when `VACUUM ANALYZE` recorded "50,000 live rows, 0 changed". When the inserts were flushed later, they landed on top of that. It only happens when the seed finishes within a second of the previous flush, which is why it came and went.
- **Counters start from zero whenever Postgres starts**, which in this app is every page load, even after a clean `close()`. `last_vacuum` and `last_analyze` are lost too. `pg_class.reltuples` (the planner's row estimate) is kept.
- PGlite has all of Postgres 18's autovacuum settings, including `autovacuum_vacuum_max_threshold` and `pg_class.relallfrozen`.

## Decision
- **Flush before reading.** The simulator, the schema browser's statistics, and the seed (between its COMMIT and its `VACUUM ANALYZE`) call `pg_stat_force_next_flush()` in a statement of its own, then read.
- **Postgres 18's rules, exactly.** `src/db/autovacuum.ts` ports `relation_needs_vacanalyze`. Thresholds are based on `reltuples` (counted as 0 for a table never vacuumed or analyzed). The insert threshold only counts pages that aren't all-frozen, and the dead-row threshold is capped by `autovacuum_vacuum_max_threshold`. Both comparisons are strictly greater-than. A table's storage parameters (`autovacuum_enabled`, `autovacuum_analyze_scale_factor`, …) override the server settings, as they do on a real server. Tables and materialized views are checked; temporary tables and the app's `visualizer` schema are skipped. The anti-wraparound vacuum is left out (it needs 200 million transactions).
- **Once after each run**, not after each statement: a run of several statements behaves like a script that finishes before a real autovacuum worker wakes up. It runs on the main thread, next to the statement runner ([ADR 0020](0020-statement-runner.md)), with Run disabled until it and the schema reload are done.
- **Never inside a transaction block.** Postgres reports the transaction status after every reply. If the visitor is inside `BEGIN`, the check waits for the run after `COMMIT` or `ROLLBACK`. VACUUM can't run in a transaction, and an ANALYZE there would be undone by a ROLLBACK.
- **VACUUM and ANALYZE together** run as one `VACUUM (ANALYZE)`, as autovacuum does.
- **Counters reset on reload, as after a crash.** The app doesn't carry them across page loads. A real server also starts its counters from zero after a crash or an immediate shutdown, and closing a tab is the closest thing to that.
- **An Autovacuum checkbox in the editor toolbar** turns the simulator off (remembered in `localStorage`). The counters keep counting while it's off, so turning it back on catches up on the next run.

## Consequences
- Plans react to data changes as they would on a real server about a minute later, and each toast says which counter crossed which threshold.
- The schema browser can show how fresh each table's statistics are: the counters next to their thresholds.
- Changes made before a reload never trigger autovacuum after it. A learner who updates 3,000 orders, reloads, then updates 3,000 more sees no ANALYZE; a real server that didn't crash would run one.
- The extra statements (a flush, two catalog reads, any VACUUM) add a few milliseconds after every run, and the VACUUM of a big table longer.

## Alternatives considered
- **Waiting a second before reading the counters:** works without the forced flush, but slows every run and still depends on timing.
- **Counting writes ourselves** from each statement's affected-row count: misses rows changed by triggers, cascades and functions, and doesn't know about HOT pruning, which removes dead rows without a VACUUM.
- **Saving counters in the `visualizer` schema across reloads:** closer to a cleanly restarted server, but the saved and live counters would need merging whenever the visitor ran VACUUM or ANALYZE by hand. Not worth it for the case it fixes.
- **Checking after every statement of Run all:** a script like `UPDATE ...; EXPLAIN SELECT ...` would then never show the stale plan a real server would give it.
