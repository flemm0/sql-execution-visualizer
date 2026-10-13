# 0038: Backward index scan replay

- **Status:** Accepted
- **Date:** 2026-10-13

## Context
With `ORDER BY ... DESC` on an ascending index, Postgres reads the B-tree backward, from high keys to low: an Index Scan Backward, or Index Only Scan Backward. Example 10's first query is one ([ADR 0037](0037-sort-and-limit-replay.md)). The walk (`btreeScan.ts`, [ADR 0025](0025-index-scan-replay.md), [ADR 0026](0026-lists-and-skip-scans.md)) ported only forward scans, and the replay reported backward ones as not available yet.

How Postgres 18.3 runs a backward scan (`nbtsearch.c`):

- `_bt_first` builds the search key from the `=`, `<` and `<=` conditions (a forward scan uses `=`, `>` and `>=`). An `=` key searches like `<=`, and the scan starts at the last entry the key doesn't sort before (for `<`, the last before it).
- `_bt_compare` treats a key equal to a downlink's kept columns as greater for a forward scan only. So a backward `<` search goes straight to the right leaf.
- A column with only a lower bound (`>` or `>=`) can't match a NULL, and NULLs sort last, so the search starts before them ("< NULL"). With no key at all, the scan goes down the right edge of the tree (`_bt_get_endpoint`).
- On a leaf, entries are read right to left. Entries marked dead are skipped, except the page's first: its key is checked, so the scan knows when the page to its left has no matches. A posting list's rows come out in ascending order all the same.
- To move on, the scan reads the page to the left, and checks that it links back (`_bt_lock_and_validate_left`).

## Decision
- **Port the backward paths of `_bt_first`, `_bt_compare`, `_bt_readpage` and `_bt_readnextpage`**, beside the forward ones, with the same scan keys and comparisons by Postgres.
- **Backward scans with arrays** (`= ANY` lists, skip scans) are reported as not available yet: `_bt_advance_array_keys` runs the other way for them, and none of the examples needs it.
- **The trace's `index.search` carries `backward: true`.** Captions say the scan looks for the last entry that can match, and moves left. The B-tree view draws the leaves a backward scan moved along right to left, the first one read under the pointer it followed, with arrows pointing left.

## Consequences
- Index Scan Backward and Index Only Scan Backward replay with otherwise the same support as forward scans: ranges, `<`, `<=`, a lower bound alone, no conditions, posting lists, dead entries skipped and marked dead.
- If the page to the left doesn't link back, the walk fails rather than guess. That only happens when another session changes the index during the walk, which PGlite's single session rules out.

## Alternatives considered
- **Keep reporting backward scans as not available:** example 10 couldn't animate.
- **Walk forward and reverse the result:** wrong pages. A backward scan starts at the other end of the range, reads its leaves in the other order, and may stop on another page.
