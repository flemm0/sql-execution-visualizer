# 0019: Display name "Pagewalk"

- **Status:** Accepted
- **Date:** 2026-10-07

## Context
[ADR 0016](0016-visual-identity.md) asks for our own name and logo. "SQL Execution Visualizer" describes the project but is long and generic. M1 was to propose a display name.

## Decision
- The app is called **Pagewalk**: the animation shows Postgres walking pages, from the index root to a leaf, to a heap page, to the result.
- The logo is three linked page tiles, stepping down in the accent colors index (sky) → heap (amber) → result (emerald). It is drawn in `src/layout/Header.tsx` and `public/favicon.svg`.
- The repository, the GitHub Pages URL, and the IndexedDB data directory keep the name `sql-execution-visualizer`, so links and visitors' saved databases keep working.

## Consequences
The name says nothing about Postgres, so it still fits if other databases are added later ([VISION.md](../VISION.md#non-goals-for-now)). The header tagline says what the app does.

## Alternatives considered
- **EXPLAINed:** a play on `EXPLAIN (ANALYZE)` that SQL users get at once, but it's an ordinary word and hard to search for.
- **Heapscope:** emphasizes the heap over the index.
- **Tuplewalk:** "tuple" is unfamiliar to part of the audience.
- Renaming the repository too: breaks the URL and visitors' stored databases for no gain.
