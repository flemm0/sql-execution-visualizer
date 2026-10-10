# 0024: A Seq Scan's trace goes page by page; the validator compares the rows shown

- **Status:** Accepted
- **Date:** 2026-10-10

## Context
The first replayer is Seq Scan (examples 2 and 11). [UX.md](../UX.md) makes one step "examine a row", and [ADR 0005](0005-realistic-data-and-30s-budget.md) has the player condense long runs of steps into stretches whose detail is computed when expanded. Condensing and expanding come in M3.

Measured in Node on the seed data, for `order_items` (1,278 pages, 200,582 rows):

- Row-level detail for every page (`heap_page_items`) takes about 1.8 s ([ADR 0022](0022-replay-pipeline-placement-and-buffer-counts.md)). [ADR 0007](0007-precompute-then-play.md) wants the trace in under a second.
- One grouped query that returns, per page, the number of visible rows and the line pointer numbers of the rows that pass the Filter takes about 100–150 ms. Postgres evaluates the Filter itself.
- Fetching all 200,582 rows again to compare their values with the result takes about 4 s.

Detail fetched later, when the visitor expands a page, could be out of date. The autovacuum simulator runs right after every run and can VACUUM the table, which removes dead row versions.

## Decision
- **A Seq Scan's trace has one `heap.page` event per page**, with the number of rows visible to the query and the number that passed the Filter, followed by one `row.emit` per matching row (with its ctid and its position in the result). There are no per-row "examine" events for Seq Scans yet. When M3 adds row-by-row playback of early pages, that detail has to be read during the run (before the autovacuum simulator) or checked against the page when it's read later.
- **The trace carries no captions.** The visualization writes them from each event's type and fields, so the trace stays plain data.
- **The validator compares values for the rows the results pane shows** (up to 1,000), in order, and the row count for all of them. The UI says when values were compared for only some rows. It also compares each node's rows, rows removed by its filter, and buffer hits and reads with `EXPLAIN ANALYZE`.
- In M2 a query replays only when every node in its plan has a replayer. Otherwise the plan pane says which node type isn't supported yet.

## Consequences
- Example 2 replays in about 150 ms. A Seq Scan of all of `order_items` adds about 0.4 s to a run that already takes about 2.5 s.
- Until M3, a Seq Scan plays a page at a time: about 1,500 steps for example 2.
- Rows the query can't see (dead or uncommitted versions) are left out of the counts. They will show up in page detail, which reads every line pointer.
- A result over 1,000 rows has its count checked, but values only for the first 1,000.

## Alternatives considered
- **Per-row events for every page, from `heap_page_items`:** the most detail, but about 1.8 s per run for the big table, and a trace of 400,000+ events that the player would condense anyway.
- **Per-row detail fetched lazily, when a page is played:** cheap, but can be out of date after the autovacuum simulator runs.
- **Comparing every result row's values:** complete, but about 4 s more for a 200,000-row result.
