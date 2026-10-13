# 0039: Show internals: where the toggle lives, and how its data is captured

- **Status:** Accepted
- **Date:** 2026-10-13

## Context
[VISION.md](../VISION.md) and [UX.md](../UX.md#visualization) promise a **show internals** toggle for learners who want more than the default view: line pointers and their offsets, tuple headers (`xmin`, `xmax`, infomask) and visibility-map bits on heap pages, and each B-tree page's high key, which the index zone leaves out ([ADR 0028](0028-index-pages-in-the-trace.md)). Every value has to come from Postgres. The trace already had each index page's high key, but nothing about heap pages beyond which rows were fetched and what became of them.

Measured in Node for `order_items` (1,278 pages, 200,582 rows): Postgres reads every line pointer with `heap_page_items` in about 90 ms, but sending all of them back and decoding them takes 1 to 6 s, about 40 µs a row with the tuple header and flags. Every page's header (`page_header`) takes about 30 ms, and the visibility map about 15 ms.

## Decision
- **A "Show internals" checkbox in the visualization pane's title bar.** It's a display setting for everything that pane shows, the animation and the page browser, so it sits on that pane, and it's there from the first visit, even with no animation yet. Off by default; remembered in that browser (`show-internals` in `localStorage`), like Empty cache, Autovacuum and Autoplay. It never reruns anything: the data is always captured.
- **It applies to the page browser too:** a table page's line pointers, tuple headers, header and map bits, and an index page's high key.
- **The trace carries `heapPages`:** for each heap page the heap zone shows, its header (`pd_lower`, `pd_upper`, line pointer count), its visibility-map bits (all-visible, all-frozen), and the line pointer and tuple header of each row the events name. A page an index-only scan skipped as all-visible gets its map bits only: the query didn't read it.
- **Read after the query, for those pages and rows only:** page headers for every page the query read, line pointers for the first 2,000 rows the events name (`MAX_TRACED_ROWS`), and the map, in three or four queries. A page whose rows weren't all kept says so, and the UI says a row's line pointer wasn't captured rather than leaving it blank.
- **Infomask names come from Postgres** (`heap_tuple_infomask_flags`), next to the raw hex values. The visibility map is decoded from its raw pages, as in [ADR 0035](0035-index-only-scan-replay.md), now with the all-frozen bit; a test checks both bits against `pg_visibility`, loaded in that test only.
- **High keys** come from the trace's `indexPages`, drawn at the right end of each page drawn in full, after a dashed divider: `HK 4393`, or `HK +∞` on the rightmost page of a level, which has none.
- **Neutral styling:** muted text and borders; the accent colors keep their meanings.

## Consequences
- Example 2 costs about 60 ms more (of a 500 ms run); a Seq Scan returning all of `order_items`, about 0.2 s more (of 4 s).
- The pages are as the query left them, not as it found them: reading a row can set hint bits (`HEAP_XMIN_COMMITTED`) and prune versions no one can see. In example 9 after the UPDATE, the old versions the scan found deleted show as dead line pointers. The UI and the docs say so.
- A query that names more than 2,000 rows (example 5's `'delivered'`, 45,000) shows line pointers for the first 2,000 only; page headers and map bits are there for every page.
- The trace gets Postgres-specific fields. They're confined to `heapPages` and shown only with the toggle on; another database would leave them empty.

## Alternatives considered
- **In the player controls, next to Autoplay:** where the animation's settings are, but the page browser has no player, and the controls appear only once there's an animation.
- **In the editor toolbar, with Empty cache and Autovacuum:** those change what a run does to the database; this only changes what the visualization shows.
- **Capturing only when the toggle is on:** cheaper for most runs, but turning it on would need a rerun to see anything, and after the autovacuum simulator the rerun may find different pages.
- **Reading the pages when shown, at play time:** no cost per run, but the pages may have changed since (autovacuum, the visitor's next statement), the reason [ADR 0028](0028-index-pages-in-the-trace.md) gives for the index pages.
- **Reading before the query runs,** as the visibility map is for an Index Only Scan: the pages as the scan found them, but a Seq Scan's matching rows aren't known until it runs, and finding them is itself a query that sets hint bits and prunes.
- **Every line pointer of every page read:** the whole page, but seconds for a big Seq Scan.
- **`pg_visibility` for the map bits:** one function call, but another extension to load, install and drop on Reset (ADR 0035's reason); it checks the decoding in a test instead.
