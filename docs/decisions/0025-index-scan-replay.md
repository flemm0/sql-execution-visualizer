# 0025: Replay an Index Scan from decoded B-tree keys, walking the index before the query runs

- **Status:** Accepted; extended by [0026](0026-lists-and-skip-scans.md) (lists of values and skip scans, and how comparisons are batched)
- **Date:** 2026-10-10

## Context
The second replayer is Index Scan (examples 1 and 4). The replay has to say which index pages the scan reads, in which order, which entries match, and which heap rows it fetches, and the validator compares the result with `EXPLAIN (ANALYZE, BUFFERS)`: rows, rows removed by the Filter, buffer hits and reads, and, new in Postgres 18, `Index Searches` (how many times the scan searched down from the root).

Three things shaped the design:

1. **Postgres doesn't log the scan's path.** pageinspect shows each B-tree page's items, but a key comes back as raw bytes (`bt_page_items.data`), and nothing says which downlink a search follows. The path depends on comparing the scan's start key with each page's keys, the way `_bt_search` and `_bt_binsrch` do, including suffix truncation: high keys and downlinks keep only the key columns needed to tell two pages apart, plus a heap row when one key value spans pages.
2. **Running an index scan changes the index.** When a scan finds that no transaction can see an entry's row any more (deleted or updated, and committed), it marks the entry dead on its leaf page (`_bt_killitems`), and later scans skip it. `EXPLAIN ANALYZE` runs first, so by the time the replay reads the index, the entries it fetched are already marked. Measured: after `UPDATE orders SET status = 'shipped' WHERE id BETWEEN 2000 AND 2010` (no room on the page, so the new versions go elsewhere and get new index entries), the first scan of `id BETWEEN 1995 AND 2015` reports 22 hits; a replay reading the index afterwards counted 1. The second run matched.
3. **Marking entries dead costs a buffer access.** Postgres 18 lets go of a leaf page once it has copied out its matches, so `_bt_killitems` reads the page again when the scan leaves it (for the next page, or at the end). Counting that access makes the first run after a delete match too.

## Decision
- **Key values are decoded from the page bytes** (`src/replay/indexKeys.ts`) for `int2`, `int4`, `int8`, `oid`, `bool`, `date`, `timestamp`, `timestamptz`, `text` and `varchar`, laid out as Postgres lays out a row (alignment per type; PGlite is little-endian with 8-byte alignment for 8-byte types). Each value becomes a SQL expression. A test decodes every entry of an index over all these types and compares the values with the rows they point at.
- **Every comparison is made by Postgres.** For each page the scan reads, one query compares each item's value with each scan key's value, with the column's type and collation (`v COLLATE "C" < 'b'::text`), and writes each value as text for the trace. The replayer only follows the nbtree rules for what to do with the answers. Comparing in TypeScript would be fewer queries but would re-implement SQL semantics (collations above all), which [ADR 0004](0004-pglite-plus-replay-engine.md) rules out.
- **The index is walked before the query runs**, right after the cache snapshot, from a plain `EXPLAIN (VERBOSE)` plan; the pages that walk loaded are then evicted again (`restoreCache` against the snapshot), so execution finds the cache exactly as the snapshot has it. After the query runs, the replay fetches the rows (visibility and Filter asked of Postgres by ctid, following HOT chains through `heap_page_items` when an entry's own row isn't visible), reads the visited leaf pages again, and treats entries dead now but not before as marked by the query: an `index.markDead` event, preceded by a buffer access to the leaf page.
- **After the replay the cache is restored** to what the query left (step 9 in [ARCHITECTURE.md](../ARCHITECTURE.md#running-a-select)). Normally the replay reads nothing new after the query (the rows and leaves it reads again are ones the query read), but if the plan that ran differs from the one walked, it walks again and reads the metapage.
- **The replay runs inside a savepoint in a transaction block**, rolled back afterwards, so a failed helper query can't abort the visitor's transaction.
- **Supported for now:** forward scans on B-trees whose key columns sort ascending, NULLs last, with the type's default operator class, and conditions `=`, `<`, `<=`, `>`, `>=` (one value each) on leading columns with `=` on every column before the last one with a condition. The rest is reported as "Animation isn’t available yet for …": lists of values (`= ANY`), skip scans (Postgres 18), backward scans (M3), `IS NULL`, expressions, other types, and keys with NULLs in some but not all columns (bt_page_items doesn't show which columns are NULL).
- New trace events: `index.search`, `index.visit` (with the downlink followed), `index.entry` (with its key), `index.markDead`, `heap.tuple` (with the visible version and whether it passed the Filter).

## Consequences
- Examples 1 and 4 replay and validate, cold and warm, and so do multi-column, text, 3-level and duplicate-key scans, and the first run after an UPDATE or DELETE.
- Three queries per index page the scan reads (two to read it, one to compare). Example 4 takes about 0.1–0.3 s in Node; a scan over every leaf of `orders_pkey` (139 pages) is about 0.5 s.
- An extra plain `EXPLAIN` was already run; walking before execution adds the walk and one eviction query to the time before the query runs, which isn't animated.
- Skip scans are the next step for M2; the walk is structured (searches, visits, entries) so a scan with several searches fits the same events.

## Alternatives considered
- **Find the start leaf from the matching rows instead of comparing keys** (ask Postgres for the matching ctids, then find the leaf holding the first one): no key decoding, but it can't follow the search down the internal pages, misses entries whose rows are dead, and doesn't extend to skip scans, whose path depends on comparisons at every step.
- **Derive pivot keys from the leaf entries next to them** (a high key is a truncated copy of the next page's first entry when the page split): fails once that entry is deleted, while the high key stays.
- **Walk the index after the query, and skip nothing marked dead:** right for the first run after a delete, wrong for every later one.
- **Read every leaf page's dead flags before the query runs:** exact too, but reads the whole index (553 pages for `order_items_pkey`) for every query.
