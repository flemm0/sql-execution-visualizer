# 0028: The trace carries the index pages it visits, keys included

- **Status:** Accepted
- **Date:** 2026-10-10

## Context
[UX.md](../UX.md#visualization) draws the B-tree path an index scan walks, with the keys on each page as real values: the root's downlinks around the one followed, and the leaf's entries around the ones that matched. Until now the trace said only which page was visited and which item's downlink was followed ([ADR 0025](0025-index-scan-replay.md)), so the index zone could list page numbers but not draw the pages.

The index walk (`btreeScan.ts`) already reads every page it visits with pageinspect, before the query runs, and asks Postgres to rank each page's key values, which also gives each value as Postgres writes it.

## Decision
- **The trace has `indexPages`:** each index page the events visit, once, in the order first visited: its level, whether it's the root, its right neighbor, its high key, and each downlink or entry (offset, key, child page or row count, whether it was dead). Keys are Postgres's own text for each value; a downlink's dropped columns are left out (the visualization shows them as `−∞`).
- They are the pages **as the walk read them, before the query ran**: what the scan itself found. Entries the query marks dead show up through `index.markDead` events.
- No new queries: the texts come from the comparison queries the walk already runs.

## Consequences
- The visualization draws real pages without reading anything at play time, so what it shows can't drift after the autovacuum simulator runs (the reason [ADR 0024](0024-seq-scan-trace-per-page.md) gives for reading detail during the run).
- The trace grows by the visited pages' items: a few hundred per page. A skip scan over a whole index (139 pages for `orders_customer_id_order_date_idx`) carries about 40,000 items, which is fine in memory.
- A test checks the pages against `bt_page_items` (example 1), and that each downlink followed leads to the next page visited (a 3-level index).

## Alternatives considered
- **Reading page contents when a page is shown:** a smaller trace, but a query per step while playing, and pages that may have changed since the run.
- **Only the followed downlink and matched entries:** enough for the path, but no neighbors, so the learner can't see why the search picked that downlink.
