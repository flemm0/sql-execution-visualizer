# 0032: Open a table's or index's pages from the schema browser

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
[UX.md](../UX.md#layout) promised that clicking a table or index in the schema browser opens its pages in the visualization pane (M2), and its idle mode (planned for M3) has the pane browse any table's or index's pages when no query is playing. Both describe the same thing. Until now the pane showed only a replayed query's animation, so a learner could see a page only through a query that happened to read it.

Reading a page with pageinspect loads it into shared buffers, like any other read. Done carelessly, browsing would turn the next query's reads into hits that the learner never caused. The pipeline already handles the same problem for the replay ([ADR 0022](0022-replay-pipeline-placement-and-buffer-counts.md)).

## Decision
- **Selecting a table or index opens it** (click, Enter or Space; arrowing through the tree doesn't). A table opens at heap page 0, an index at its root. The animation pauses, and **Back to the animation** returns to it at the same step.
- **A table's page** lists every line pointer with its ctid. A row the visitor's session can see shows its values as Postgres prints them. Every other line pointer says why it holds no visible row: not visible (deleted, replaced by an UPDATE, or not committed), dead, unused, or a redirect. The arrows, a page number box and a clickable mini-map move between pages. The values come from a TID range scan of that one page, and the line pointers from `heap_page_items`.
- **An index's page** lists its downlinks (a key and the child page) or its entries (a key and the heap rows it points at), with dead entries struck through. Keys are decoded as the replay decodes them ([ADR 0025](0025-index-scan-replay.md)) and printed by Postgres. Truncated columns show as −∞. Keys of types the decoder can't read yet show their bytes, with a note. A downlink opens its child, the arrows open the left and right siblings, **Back** retraces the way you came and **Root** goes to the top. Clicking an entry's heap row opens that table page with the row highlighted. High keys stay hidden, as in the animation; show internals (M3) adds them. Only B-tree indexes can be browsed so far; any other index type says so.
- **Browsing leaves no trace.** Every read snapshots which of the table's and its indexes' pages are cached, then evicts any page it loaded (`restoreCache`). Inside a transaction block, the reads run in a savepoint that is rolled back, so a failed read can't abort the visitor's transaction. In a failed transaction, the pane says to run ROLLBACK first.
- **One thing at a time.** A page isn't read while a run or its tidying-up is under way, and Run waits for a page read to finish. Reads run one after another.
- **Runs and the open page.** A run with a query to animate takes the pane back for its animation. Any other run leaves the open page in place and reads it again, so the page shows what an INSERT, UPDATE, DELETE or VACUUM just did.
- **Idle mode is this.** UX.md's idle mode is no longer a separate M3 item.

## Consequences
- Truthful: every value, key, ctid and page link comes from Postgres, and the cache is left as the last query left it (tested).
- One page at a time. There's no drawing of the whole tree, and a heap page shows no tuple headers (xmin, xmax, infomask) until show internals arrives.
- Reading a table page's rows can prune the page, as any query that reads it can. The line pointers are read after the rows, so they show the page as it is after pruning.
- A posting list shows its first 3 heap rows and a count of the rest.

## Alternatives considered
- **A separate "Show pages" button in the details panel**: one more step for the main way in. Clicking the object is what UX.md describes.
- **Opening pages in place of the animation with no way back**: a learner clicking a table to check a column would lose the animation they were watching.
- **Drawing the index with the animation's B-tree view**: that view is built around a search's path. A page browser has no path, and a list of every key on the page answers "what is on this page" more directly.
- **Leaving browsing's buffer side effects alone**: the next query's hits and reads would no longer be its own.
