# 0014: Simulate autovacuum

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
PGlite runs Postgres as a single process, which has no autovacuum. Without it, planner statistics and the visibility map go stale after writes until the user runs `ANALYZE` or `VACUUM`. That diverges from how a real server behaves.

## Decision
After each write, the worker reads `pg_stat_user_tables` and applies Postgres's default autovacuum thresholds. When a table crosses them, it runs `ANALYZE` and/or `VACUUM` on that table and shows a notice ("autovacuum: analyzed orders"). A setting turns the simulator off for studying stale statistics. The seed is `VACUUM ANALYZE`d after generation.

## Consequences
Plans react to data changes roughly as on a real server (which runs autovacuum within about a minute). This depends on PGlite maintaining `pg_stat_user_tables` counters; verify in M1. Verified in M1: they work once flushed. The details (flushing, Postgres 18's exact thresholds, transactions, reloads) are in [ADR 0021](0021-autovacuum-simulator.md).

## Alternatives considered
- Nothing automatic, with a "stats stale" badge: truthful to PGlite but not to real Postgres.
- `ANALYZE` after every write: unrealistic.
