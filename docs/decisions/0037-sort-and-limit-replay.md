# 0037: Sort and Limit replay: a Sort holds every row, a Limit stops what's below it

- **Status:** Accepted
- **Date:** 2026-10-13

## Context
Example 10 ([DATA.md](../DATA.md)) is about top-N queries. `WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3` runs as a Limit over an Index Scan Backward: the index is already in that order ([ADR 0038](0038-backward-index-scans.md)). `ORDER BY total DESC LIMIT 10` runs as a Limit over a Sort over a bitmap scan. Sort and Limit are the first nodes that read no pages. A Sort holds every row it's given before it passes one on (buffering), and a Limit stops asking once it has its rows, so the nodes below it stop part way (stopping early).

From Postgres 18.3, measured in PGlite and read in its source:

- EXPLAIN doesn't show a Limit's LIMIT or OFFSET, even with VERBOSE. With `debug_print_plan` on and `client_min_messages` at `LOG`, Postgres sends its whole plan tree to the client as a notice. The planner has already worked out constant expressions there: `LIMIT 2 + 1` is 3.
- A Sort whose parent is a Limit gets a bound, LIMIT + OFFSET (`ExecSetTupleBound`). It holds every row until it has more than twice the bound, then keeps only the best ones in a heap: a top-N heapsort (`tuplesort.c`). Otherwise it sorts everything in memory with its quicksort (`sort_template.h`), or spills to disk past `work_mem`: at 4 MB, `SELECT * FROM orders ORDER BY total` spills. Rows that tie on every sort key come out in whatever order the algorithm leaves them in.
- A Limit that has its rows doesn't ask its child again (`nodeLimit.c`), so the child never finishes. An index scan stopped this way marks the dead entries on its leaf as the query ends (`btendscan`), and no node's buffers count that.
- A Seq Scan and a Bitmap Heap Scan read heap pages through a read stream, which asks for the pages the scan will need next in batches: 1, 2, 4, 8, then 16 pages (`io_combine_limit`). PGlite runs Postgres with `io_method = sync`. There a batch is read, and counted as reads, when the scan reaches its first page. A page already in shared buffers counts as a hit as soon as the stream pins it, ahead of the scan. A scan that reads to its end uses every page it asked for. One that a Limit stops has asked for pages it never uses, and Postgres counts them: `SELECT * FROM order_items LIMIT 3000` needs 20 pages and reads 31.

## Decision
- **A Limit's LIMIT and OFFSET come from Postgres's plan tree** (`limits.ts`): logged with `debug_print_plan`, after the query runs, and matched to the plan's Limit nodes in order, outermost first. (Plan node ids don't do: when the planner drops a Subquery Scan that does nothing, the plan under it keeps the subquery's numbers.) FETCH FIRST … WITH TIES, and a LIMIT only known when the query runs (a parameter, a subquery), are reported as not available yet. The trace keeps each Limit's settings (`Trace.limits`).
- **Each node is told how many rows its parent will ask it for** (`rowsNeeded` in `replay.ts`). A Limit asks for OFFSET + LIMIT and passes that down; a Sort asks for all. A scan stops after that many rows, wherever it is, and doesn't finish:
  - an index scan, after the row;
  - a Seq Scan, part way through its page, with the Filter checked only up to there (`heap.page` carries `checkedRows`, the visible rows it got to; one more query counts them);
  - a Bitmap Heap Scan, after the row, on its page.

  LIMIT 0 asks for nothing: the nodes below it never start.
- **A Limit's steps:** each row from below is skipped for the OFFSET (`limit.skip`) or passed on (`row.emit`). Once the Limit has its LIMIT, it stops (`limit.stop`, naming the nodes below it that hadn't finished). The player marks those nodes stopped.
- **A Sort's order is Postgres's own, ties included.** Postgres ranks the rows the Sort was given (`dense_rank()` over the plan's own sort keys, which EXPLAIN writes as ORDER BY items). A port of tuplesort's in-memory sorts, quicksort and top-N heapsort, puts them in order, as the B-tree walk ports nbtree ([ADR 0025](0025-index-scan-replay.md)). Only the sign of each comparison matters, as in Postgres. The trace has the Sort's rows with their sort keys' values and ranks (`Trace.sorts`).
- **A Sort's steps:** each row from below is its child's `row.emit`. The Sort just holds it, so there's no step of its own, as a bitmap index scan's mark is part of its entry's step ([ADR 0036](0036-bitmap-scan-replay.md)). In a top-N heapsort there is one step for the switch (`sort.heap`), and for each later row, whether it takes the worst kept row's place (`sort.keep`) or is dropped (`sort.discard`). Then comes the sort itself (`sort.done`), then its rows, in order. A sort that spills to disk is reported as not available yet. So is one where Postgres switched to a top-N heapsort early because memory ran out, which the replay notices because Postgres's Sort Method differs from its own.
- **Read-ahead a stopped scan never uses is shown when it stops.** A port of `read_stream.c`'s look-ahead in sync mode (`readStream.ts`) works out which pages Postgres counted beyond the last one the scan used. The trace has them as buffer accesses marked `ahead`, after the Limit's stop. Pages the scan does go through are still drawn as read when it reaches them (ADR 0036).
- **The visualization:**
  - A Sort zone, in violet (an intermediate result), lists the rows the Sort holds with their sort keys. In a top-N heapsort it lists the best kept, with the worst last. Once sorted, it lists the rows it passes on, in order.
  - A line under the node line counts the Limit's rows against its LIMIT (and OFFSET), and says when it stopped.
  - Pages read ahead are dotted slots in the buffers zone, and faint amber on the mini-map.
  - The plan tree marks stopped nodes "stopped early".

## Consequences
- Example 10 replays and validates, and so do OFFSET, LIMIT 0, a top-N heapsort over all of `orders` (50,000 rows, about 101,000 steps), rows that tie, a Limit over every scan, and a Sort over every scan.
- One more helper query per Limit (an EXPLAIN with the plan tree logged), and one per Sort, to rank its rows by `ctid`.
- The read stream port depends on PGlite's settings: `io_method = sync`, `io_combine_limit` 16, `effective_io_concurrency` 16, and a pin limit of 98 that Postgres works out from `shared_buffers` and its maximum number of processes. It also counts two pins the backend holds besides the stream's, which is an estimate. It matches every measured case (empty, warm and partly cached tables); a case it got wrong would fail the buffer checks.
- Read-ahead is drawn at the stop, not when it happened, and its caption says it had already been read. Read-ahead that the scan does use is still drawn page by page.
- A stopped index scan marks its dead entries at the stop, before the Limit finishes, rather than after it, and with no buffer access, as EXPLAIN counts it.

## Alternatives considered
- **Reading LIMIT from the SQL text:** simple for `LIMIT 3`, but then the app parses SQL (expressions, FETCH FIRST, views), when Postgres should decide ([ADR 0004](0004-pglite-plus-replay-engine.md)).
- **Working out the count from EXPLAIN ANALYZE's rows:** a Limit's actual rows say how many it passed on, but not whether it then asked once more and found its child empty. That decides whether the scan below read to its end: a Seq Scan of `orders` whose only matching row is on page 0 reads one page under LIMIT 1, and all 589 under LIMIT 2.
- **Sorting the rows with ORDER BY:** right except for ties, which Postgres's quicksort and heap leave in an order of their own. The validator compares the rows' values in order, so ties between different rows would fail.
- **Stopping generators lazily** (the Limit just stops pulling, as in Postgres): natural, but a Seq Scan's trace is per page ([ADR 0024](0024-seq-scan-trace-per-page.md)), and its `heap.page` comes before its rows. Telling the scan how many rows it will be asked for lets that step say how far into the page the scan got.
- **Not replaying a Limit that stops a Seq Scan or Bitmap Heap Scan early:** simpler, but `SELECT * FROM orders LIMIT 10` is among the first queries a learner types.
- **Drawing every read stream batch when it happens:** more faithful for whole scans too, but it would change the rhythm of every Seq Scan and bitmap scan animation. It's a decision of its own.
