# 0008: Show disk → shared buffers → executor, starting with an empty cache

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
The requirement is to show rows being fetched by reading pages from disk into memory. Postgres reads every page through its shared buffer cache.

## Decision
The visualization has three zones: disk (heap and index files as numbered pages), shared buffers (cache slots), and the executor. A miss animates a page moving from disk into a slot; a hit flashes the slot. Hit and read counts are validated against `EXPLAIN (BUFFERS)`. "Start with an empty cache" is on by default (implemented with `pg_buffercache_evict_relation`); switching it off and rerunning shows hits.

## Consequences
Matches the learner's mental model and Postgres's real behavior. In PGlite the "disk" is itself in browser memory, so the app shows logical hits and reads, not real I/O timing. Our own `pageinspect` reads must be evicted afterward so they don't pollute the cache ([ARCHITECTURE.md](../ARCHITECTURE.md#running-a-select)).

## Alternatives considered
- Pages only, no cache: simpler but less true.
- A tiny buffer pool to show eviction: deferred to v3.
