# 0036: Bitmap Heap Scan replay: build the bitmap, then read its pages in physical order

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
A Bitmap Heap Scan sits over a Bitmap Index Scan. The index scan walks its index as an Index Scan does, but fetches nothing: it marks each matching entry's row in a bitmap (one entry per heap page, holding the rows on it that matched). Only when it's done does the heap scan sort the bitmap's pages into physical order and read each one once, checking the marked rows on it. That's the point of examples 3, 6 and 12 ([DATA.md](../DATA.md)): where an Index Scan jumps between heap pages in index order and comes back to pages it read before, a bitmap scan reads each page once, in order.

The plan has two nodes, so it's the first replay with a parent and a child, and the trace needs a shape the single-node scans didn't: a phase that only builds something, then a phase that uses it.

Measured in PGlite (Postgres 18.3), on an empty cache:

| Query | Rows | Index pages | Heap pages (Exact Heap Blocks) |
|---|---|---|---|
| `orders WHERE customer_id BETWEEN 100 AND 300` (example 6) | 944 | 1 hit, 3 reads | 480 reads |
| `orders WHERE customer_id BETWEEN 1 AND 100` (example 12) | 468 | 2 hits, 1 read | 312 reads (an Index Scan of the same rows: 312 reads and 154 hits) |
| `order_items WHERE product_id = 42`, with an index on `product_id` (example 3) | 189 | 2 reads | 177 reads |

Each heap page in the bitmap is exactly one buffer access, whatever Postgres 18's read stream prefetches, and the visibility map isn't read (a query that returns columns needs every row). The Bitmap Index Scan's buffers are its own, and the Bitmap Heap Scan's include them, as for any parent. `Index Searches` is reported for the Bitmap Index Scan as for an Index Scan, and its `Actual Rows` is the number of rows it marked.

Example 5 turned out not to need a bitmap scan: with an index on `status`, `'pending'` is an Index Scan and `'delivered'` a Seq Scan, both already replayed.

## Decision
- **The Bitmap Index Scan's index is walked like an Index Scan's** (`btreeScan.ts`, [ADR 0025](0025-index-scan-replay.md), [ADR 0026](0026-lists-and-skip-scans.md)), before the query runs, with the same support: ranges, lists, skip scans. Its node names no table, so the walk takes the table's alias from the Bitmap Heap Scan. It marks no entries dead: only a scan that fetches rows learns nobody can see them, so there's no `index.markDead` and no extra leaf access.
- **The trace keeps the executor's order:** the Bitmap Heap Scan starts; the Bitmap Index Scan starts, walks the index, and finishes, every `index.entry` carrying `bitmap: true` (its row is marked, not fetched); then, for each page the bitmap marks, in page order, one buffer access, and for each marked row on it, in line pointer order, a `heap.tuple` (visible version, Filter) and a `row.emit` if it passes. Marking a row is part of the entry's step: Postgres does nothing else with it then, and there's no decision to explain, so it doesn't get a step of its own.
- **A node's rows are what it passes on** (`passesRowOn`): `row.emit`, or for a bitmap index scan, the rows it marks. The validator, the plan tree and the node line all count that way.
- **The validator checks `Exact Heap Blocks`** against the distinct heap pages the Bitmap Heap Scan read.
- **A lossy bitmap isn't replayed.** When a bitmap outgrows `work_mem`, it keeps some pages whole and Postgres rechecks every row on them; which pages depends on how its hash table fills up. The plan pane says so ("Animation isn't available yet for lossy bitmaps …"). With the default 4 MB no seed query comes close (in PGlite, 64 kB still lists about 1,170 pages exactly). BitmapAnd and BitmapOr report as nodes not available yet.
- **The visualization draws the bitmap in violet**, the color for intermediate results: each marked page turns violet on the heap mini-map as the index scan marks it, then amber or emerald as the heap scan reads it, so the sweep in physical order is visible. A line above the mini-map counts the bitmap's rows and pages and how many have been read; the page being read says how many rows the bitmap marks on it. In the B-tree, a match's pointer is violet and says "bitmap: row (118,54)" instead of "heap row". Captions say the row is marked instead of fetched, sum up the bitmap when the index scan finishes, and number each heap page as "page 37 of 480 in the bitmap".
- **When a child node finishes, its parent is the active node again** in the player (a stack, not one slot), and the caption says what the child passed up.

## Consequences
- Examples 3, 6 and 12 replay and validate, cold and warm, and so do lists, skip scans, Filters, rows deleted or updated (HOT or not), and the visitor's uncommitted changes. Example 6 is about 3,300 steps (110 s at the default speed) until M3's condensing.
- Within a page, Postgres checks which marked rows are visible all at once when it reads the page (`heapam_scan_bitmap_next_block`), then checks the Filter and returns them one by one. The trace has one `heap.tuple` per row, with visibility and Filter together, followed by its `row.emit`, as for an Index Scan. The rows, their order and every count are Postgres's; only when visibility is checked within the page is drawn later than it happens.
- Walking the index before the query can't be told apart from walking it after in Postgres 18, since nothing marks entries dead in between. It keeps one rule for every index scan, and stays right if a later Postgres starts marking entries dead from bitmap scans.
- No new queries beyond an Index Scan's: the walk, then one query for which version of each marked row the query sees.

## Alternatives considered
- **A `bitmap.add` step after each `index.entry`:** more literal, but doubles the index phase's steps (944 more for example 6) for an action with nothing to decide.
- **Telling bitmap entries apart by the plan node's type in the player:** no change to the trace, but then the trace doesn't say what happened by itself, and the player would need Postgres's node names.
- **A `bitmap.page` step before each heap page access:** says "next page in the bitmap" outright, but the buffer access already is that step; its caption says it, with the page's place in the bitmap.
- **Modelling lossy pages:** would mean porting the bitmap's hash table and its lossify order, for a case the seed data never reaches.
