# 0010: Release scope: v1 single-table, v2 joins, v3 writes

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
The full vision (joins, subqueries, animated writes, many index types) is large. The replay engine and validator must be proven on simple cases first.

## Decision
- **v1:** single-table SELECT (Seq Scan, Index Scan, Index Only Scan, Bitmap scans, Sort, Limit) on B-tree indexes. Other statements run for real but aren't animated.
- **v2:** joins, Materialize, aggregates, subqueries and CTEs, with intermediate results.
- **v3:** animated writes and MVCC, VACUUM, other index types, window functions, a tiny buffer pool.

See [ROADMAP.md](../ROADMAP.md).

## Consequences
v1 covers the book's early chapters. Joins arrive once the replay and validation approach is proven.

## Alternatives considered
- Joins in v1: they are a headline requirement, but they multiply replay complexity before the foundation is validated.
