# 0015: Branch-per-feature PRs and milestone order

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Flemming reviews the work; Claude writes most of it.

## Decision
- Claude works on a branch per feature and opens a PR; Flemming reviews and merges on GitHub.
- CI (typecheck, lint, tests, build, smoke test) runs on every PR; merging to `main` deploys.
- Build order: M0 foundations → M1 Postgres in the browser → M2 replay engine and player → M3 rest of v1 → v2 → v3 ([ROADMAP.md](../ROADMAP.md)).

## Consequences
Every change has a review surface and a green CI run before it goes live. M0 surfaces the hosting risk on day one.

## Alternatives considered
- Committing straight to `main` after a chat OK: faster, but no review trail.
