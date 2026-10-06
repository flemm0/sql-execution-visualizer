# 0011: Persist each visitor's database in IndexedDB

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Learners create indexes and change data; losing that on reload is frustrating.

## Decision
- PGlite stores its data directory in IndexedDB.
- **Reset database** restores the seed.
- A stored seed version triggers a reset offer when a release changes the seed.

## Consequences
Changes survive reloads, and seeding happens once per browser. Each visitor's data is private to their browser.

## Alternatives considered
- A fresh in-memory database every load: simpler, but changes are lost and the seed regenerates each time.
