# 0035: Index Only Scan replay

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
An Index Only Scan answers a query from the index alone when it can. Whether it can, row by row, is decided by the table's visibility map: one bit per heap page says every row on it is visible to every transaction. VACUUM sets the bit; any change to the page clears it. Example 9 ([DATA.md](../DATA.md)) shows this as Postgres's `Heap Fetches` going 0 → 6 → 3 → 0 across an UPDATE and a VACUUM. The replay has to show which rows were fetched and which weren't, and get every buffer hit and read right, the map's own page included.

Measured in PGlite (Postgres 18.3) for example 9, on an empty cache: 3 reads after seeding (the index's root and leaf, and the map's page 0); after the UPDATE, 2 hits and 7 reads with 6 heap fetches, and no extra access for marking the 3 old entries dead.

## Decision
- **The index is walked as for an Index Scan** ([ADR 0025](0025-index-scan-replay.md), [ADR 0026](0026-lists-and-skip-scans.md)), with the same support and the same `Unsupported` reasons.
- **The visibility map is read before the query runs**, with the walk (step 3 in ARCHITECTURE.md): the bits of the heap pages the walk's entries point into, decoded from the map's raw pages with `get_raw_page(…, 'vm', n)`, then evicted like the walk's pages. A SELECT doesn't set or clear bits in Postgres 18, but reading them first means the replay sees exactly what the scan saw.
- **Per entry, a `visibility.check` event**: all-visible (no fetch; it carries whether the entry passed the Filter) or not (a `heap.tuple` follows, as for an Index Scan). The map's page is a buffer access of its own, `fork: 'vm'` on the table's `PageRef`, counted once: the scan keeps the map page it last read pinned, and one page covers 32,672 heap pages. A table with no map yet costs no access.
- **No buffer access for marking entries dead:** an Index Only Scan keeps its leaf pinned (nbtree drops the pin only for plain index scans), so `_bt_killitems` locks the page it holds.
- **The validator checks `Heap Fetches`** against the replay's `heap.tuple` events, and counts entries rejected on all-visible pages in `Rows Removed by Filter`.
- **The visualization:** the map's page is a dashed amber slot (`vm0`); a page skipped because it's all-visible is sky in the mini-map (its rows came from the index) and the heap zone says "all-visible: not read".

## Consequences
- The replay still asks Postgres, for every entry, which version of its row the query sees: the validator reads the result's values by `ctid`, and after a HOT update and VACUUM an entry's line pointer redirects to the version still there. This reads heap pages the scan didn't; step 9 evicts them again.
- No new extension: `pageinspect` reads the map. The decoding assumes Postgres's layout (24-byte header, two bits per heap page), which a test pins: a wrong bit makes every Index Only Scan test fail.
- The B-tree view still draws an arrow from a matched entry to "heap row (119,59)", as for an Index Scan, though the row isn't fetched when its page is all-visible; the caption and heap zone say so.

## Alternatives considered
- **`pg_visibility`** (bundled with PGlite): reads the same bits with one function call, but adds an extension to load, install and drop on Reset, for a few lines of decoding.
- **Reading the map after the query:** simpler, and the same in Postgres 18, but a later Postgres that sets bits during on-access pruning would make it wrong without any test noticing.
- **Folding the check into `index.entry`:** fewer steps, but the player would have no step at which to say why the heap was or wasn't read, which is the point of the example.
