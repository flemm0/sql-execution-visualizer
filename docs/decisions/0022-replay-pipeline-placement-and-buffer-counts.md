# 0022: Run the replay pipeline on the main thread, and reproduce buffer counts exactly

- **Status:** Accepted
- **Date:** 2026-10-09

## Context
Before building M2 (inspector, replay engine, validator), a spike checked three assumptions in [ARCHITECTURE.md](../ARCHITECTURE.md) against PGlite 0.5.8 (Postgres 18.3):

1. **Where the pipeline runs.** The architecture put the inspector, replay and validator in the Web Worker, next to Postgres. Since [ADR 0020](0020-statement-runner.md), the statement runner sends queries from the main thread through PGlite's worker proxy. Replay makes many small queries, so the cost of each one matters.
2. **Emptying the cache.** "Start with an empty cache" ([ADR 0008](0008-model-shared-buffers.md)) depends on `pg_buffercache_evict_relation`, which is new in Postgres 18.
3. **Exact buffer counts.** The validator compares the replay's hits and reads with `EXPLAIN (BUFFERS)`, so the replay has to know exactly which page accesses are hits and which are reads.

### What the spike measured

**Query cost** (headless Chromium in a cloud container, so absolute times are rough; 20–300 queries each):

| How the query is sent | Per query |
|---|---|
| PGlite in the same thread, in memory | 0.1–0.4 ms |
| Through the worker proxy, `execProtocolRaw` (what the runner uses), IndexedDB storage as today | ~37 ms |
| Through the worker proxy, `db.query`, IndexedDB storage as today | ~280 ms |
| Through the worker proxy, `execProtocolRaw`, with `relaxedDurability` | ~1.4 ms |
| Through the worker proxy, `db.query`, with `relaxedDurability` | ~12 ms |

A `BroadcastChannel` round trip, which the proxy uses, costs 0.1–0.4 ms, so the message hop isn't the expensive part. The cost is PGlite saving the database to IndexedDB after **every** query, reads included, and waiting for the save before answering. `db.query` costs three proxy calls (take the query lock, run, release it), and each one is slow.

This affects the app as it is today. Running `SELECT * FROM orders WHERE id = 4242` (EXPLAIN plus the query) takes about **320 ms**, and the schema browser's reload after each run takes about **1.35 s**. With `relaxedDurability`, PGlite starts the save but doesn't wait for it, and the same run takes about **21 ms** and the reload about **60 ms**.

**Emptying the cache:** `pg_buffercache_evict_relation`, `pg_buffercache_evict` (one buffer) and `pg_buffercache_evict_all` all exist and work. After evicting `orders` and `orders_pkey`, `pg_buffercache` shows none of their pages, and the next query reads every page it touches.

**Buffer counts** for the M2 examples, with an empty cache, match a model of the executor exactly:

| Query | Plan | Execution reads | Pages |
|---|---|---|---|
| `orders WHERE id = 4242` (example 1) | Index Scan | 3 | B-tree root, one leaf, one heap page |
| `order_items WHERE product_id = 42` (example 2) | Seq Scan | 1,278 | every heap page once |
| `orders WHERE id BETWEEN 1000 AND 2000` (example 4) | Index Scan | 18 | root, 4 leaves, 13 heap pages |
| `categories WHERE id = 3` (example 11) | Seq Scan | 1 | the one heap page |

Rerunning each one gives the same numbers as hits instead of reads.

Things the spike found along the way:

- **Planning reads pages too.** `EXPLAIN (BUFFERS)` reports planning separately from the plan's nodes. The first time a session plans with an index, the planner reads its metapage, and Postgres then keeps it in memory outside the buffer cache, so index scans never read the metapage during execution. When a range starts near a column's minimum or maximum, the planner also probes the index for the real extreme value. For `orders WHERE customer_id BETWEEN 1 AND 100` it loaded the B-tree root and the first leaf, so during execution those two were hits, not reads, even with an "empty" cache.
- **A heap page is counted when the block changes.** An index scan keeps its heap page pinned while consecutive index entries point into that page, and only counts a buffer access when it moves to another page. Going back to a page visited earlier counts as a hit. With this rule, `customer_id BETWEEN 1 AND 100` (468 rows over 312 heap pages, in index order) predicts 154 hits and 312 reads, exactly what Postgres reports.
- **Inspection pollutes the cache, and it can be undone.** `get_raw_page`, `bt_page_items` and `bt_metap` read through shared buffers. Evicting each buffer that wasn't in a snapshot taken before inspection restores the cache exactly (about 20 ms for a few pages).
- **No ring buffer for the seed tables.** Postgres uses a small ring of buffers for a Seq Scan of a table larger than a quarter of `shared_buffers`. PGlite has 128 MB of shared buffers (16,384 pages), so that only kicks in above 4,096 pages. The biggest seed table, `order_items`, has 1,278. The whole database (about 31 MB) fits in shared buffers, so nothing is ever evicted during a run.
- **Reading a whole table's pages is slow.** `heap_page_items` over all 1,278 pages of `order_items` (200,582 line pointers) takes about 1.8 s in Node. One page takes about 1–2 ms. Asking Postgres for `ctid`s instead is fast: the `ctid`s of the 189 rows matching `product_id = 42` come back in about 15 ms.

## Decision
- **The inspector, replay engine and validator run on the main thread**, over the same worker connection as the statement runner. They send queries with `execProtocolRaw` (the simple query protocol, as the runner does), never `db.query`.
- **Page data is read in batches and only when needed:** one query per relation and step (for example, per-page row counts for a Seq Scan from `ctid`s), and `heap_page_items` / `bt_page_items` only for pages the player shows in detail ([ARCHITECTURE.md, lazy detail](../ARCHITECTURE.md#player-main-thread)).
- **PGlite runs with `relaxedDurability`.** This lands in its own PR, together with Playwright checks that changes still survive a reload, because it changes how M1 persists data ([ADR 0011](0011-persist-in-indexeddb.md)).
- **A SELECT runs in this order:**
  1. If "Start with an empty cache" is on, evict every relation in the query with `pg_buffercache_evict_relation`.
  2. Plan it with a plain `EXPLAIN` (no ANALYZE), so the planner's own reads happen now.
  3. Snapshot the cache (`pg_buffercache`) for the query's relations.
  4. Run `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`, then the query for its rows.
  5. Snapshot the cache again: this is what the query left behind.
  6. Inspect pages, replay, validate.
  7. Evict each buffer that is cached now but wasn't in snapshot 5 (`pg_buffercache_evict`).
- **Hits and reads come from snapshot 3**: a page access is a hit if the page was in snapshot 3 or was already read earlier in this run, and a read otherwise. Heap accesses follow the block-change rule above.
- **Planning reads are not animated.** The plan view reports them as a note ("planning read 2 index pages"), since they come from steps the trace doesn't show.

## Consequences
- No second message layer next to PGlite's multi-tab leader election. With several tabs open, only the leader tab's worker holds the database, so code in "our" worker would often be forwarding to another tab anyway.
- Each query costs about 1 ms more than it would inside the worker. With batching, a run makes a few dozen queries, so this stays well under the "under a second" target of [ADR 0007](0007-precompute-then-play.md).
- `relaxedDurability` makes the whole app much faster, but a write made in the last moment (one save, about 40 ms here) before the tab closes can be lost.
- The extra plain `EXPLAIN` adds one query per run.
- A table a learner makes larger than 4,096 pages would get a ring buffer on Seq Scan, and its counts would not match. The validator flags that, and the UI says so.
- Executing the query twice (EXPLAIN ANALYZE, then the query) leaves the same pages cached, because the first run already loaded everything the second needs.

## Alternatives considered
- **Pipeline in the worker:** saves about 1 ms per query, but needs our own RPC layer beside PGlite's leader election, which ADR 0020 already turned down.
- **Snapshot before planning** (one EXPLAIN ANALYZE, no plain EXPLAIN): the planner's index probes then look like execution hits with no read before them, and the validator fails on queries near a column's minimum or maximum.
- **Animating planning reads:** true, but the planner's catalog lookups (17–27 hits per query) would swamp a 3-page index lookup. Revisit if learners ask about planning.
- **Keeping full durability and skipping the save only for the pipeline's read-only queries:** PGlite's `execProtocolRaw` has a `syncToFs: false` option, but the worker proxy doesn't pass options through.
- **OPFS storage instead of IndexedDB:** might save faster, but it's a bigger change to persistence and isn't needed if `relaxedDurability` holds up.
