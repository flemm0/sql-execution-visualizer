# 0026: Replay lists of values and skip scans by porting nbtree's array keys

- **Status:** Accepted
- **Date:** 2026-10-10

## Context
[ADR 0025](0025-index-scan-replay.md) replays an Index Scan that searches its index once. Two kinds of scan search it several times, and Postgres 18 reports how often (`Index Searches`):

- **A list of values**, `id IN (5, 77, 9000)`, which the plan writes as `id = ANY ('{5,77,9000}'::integer[])`.
- **A skip scan** (new in Postgres 18): a condition on a later column of a multi-column index, with no `=` on the columns before it, like example 8's `first_name = 'Mary'` on `(last_name, first_name)`. Postgres treats each such earlier column as a list of every value it holds (a "skip array"), so the scan finds the Marys under each last name in turn.

Which pages such a scan reads isn't simply "one search per value". nbtree keeps the scan's current values in **array keys** and moves them on as it reads entries (`_bt_advance_array_keys`); after each move it either keeps reading leaf pages to the right, or ends the "primitive" scan and searches again from the root. That choice uses the page's high key, whether the scan has already read more than one page, how often a skip array moved on this page (more than 3 times: keep reading), whether a high key's columns were truncated (then read the next page, and re-check there), and a lower bound the high key fails. Getting any of it wrong changes `Index Searches` and the buffer counts, and the validator catches it.

Two more details matter:

- Types whose operator class has **skip support** (integers, `date`, `timestamp`, `timestamptz`, `bool`, `oid`) step from a value straight to the next one (42 to 43) and search for that; others (`text`, `varchar`) search for "the first value after 42" instead. With skip support, `a > 5` on a skipped column also becomes `a >= 6`, so the first search can use the later columns' conditions too.
- A session's **first** scan that needs skip support, or a cross-type comparison, looks it up in the system catalogs, and Postgres counts those page accesses as the scan's buffer hits (measured: 2 to 9 extra hits; none on the next run). The same already happened for a cross-type `=` like `id = 42::bigint`.

## Decision
- **Port the deciding parts of nbtree** (`src/replay/btreeScan.ts`): preprocessing of the scan keys into lists, skip arrays (with their bounds and the `>` to `>=` adjustment) and plain keys (`_bt_preprocess_keys`); building the search key (`_bt_first`); reading a leaf page (`_bt_readpage`, `_bt_checkkeys`, `_bt_check_compare`); and moving the arrays on and deciding where the scan goes next (`_bt_advance_array_keys` and its helpers, `_bt_scanbehind_checkkeys`, `_bt_oppodir_checkkeys`). Each function names the one it follows and keeps its structure, so the two can be read side by side. The plain scans of ADR 0025 run through the same code, without arrays.
- **Leave out what changes speed, not pages:** parallel scans, the "look ahead" within a page (it skips entries that would fail anyway), and treating keys as not required on a primitive scan's later pages (`_bt_set_startikey`: it reads entries the required keys would have skipped, on a page that's read either way, and resets the arrays before the high key, which leaves them where the full rules would). Any difference would show up as a failed check.
- **Postgres still makes every comparison** (`src/replay/keyComparisons.ts`), but nbtree compares far more often than the single-search scans did, and also compares values with each other (a skip array's current value comes from the index). So when the walk reads a page, one query ranks all the page's values in each column, together with the arrays' current values and, for skip support, the value after each; compares each with each condition's value (cross-type comparisons included); and finds each one's place in each list. Any comparison not answered yet runs one more query. Pages are read once per walk, though a search can pass through the root many times.
- **A "next value" is known by an equal value from the page, or by its text**, never as an expression built on the previous one: that expression doubles in size with each step, and a scan over thousands of values crashed Postgres.
- **The validator stays strict about the catalog lookups**, and a note explains them when a skip scan's only failed checks are buffer hits with Postgres counting more: "A session’s first skip scan over a column type also reads system catalog pages, … Run the query again to compare."
- **Dead entries are marked when the scan leaves a leaf page for a new search** too, not only for the next leaf or the end, and only those the scan returned on that visit.
- **Supported:** `= ANY` on a key column (alone on its column; NULLs and duplicates in the list are dropped, an empty list searches nothing, a list of one value is a plain `=`), skip arrays over any key column before the last one with a condition, with or without `>`, `>=`, `<`, `<=` on it. Still reported as not available: other list operators (`< ANY`, `= ALL`), several conditions of one kind on a column, backward scans, `IS NULL`, expressions.

## Consequences
- Lists and skip scans replay and validate, cold and warm: 50 queries checked against Postgres while building this (lists of 0 to 14 values, across types; skip scans over `int2`, `int4`, `int8`, `bool`, `date`, `timestamptz`, `text` and `varchar` columns, with ranges, NULL groups, two skip arrays, and up to 12 searches), and the first scan after a delete. The tests keep a representative set.
- About one query per page read, plus the page reads themselves. A skip scan over every leaf of `orders_customer_id_order_date_idx` (139 pages, one search) takes about 2.7 s to walk in Node; example 8's shape on `customers` about 0.6 s. Walks this long happen only when the planner picks a skip scan over a whole index; for the seed data it prefers a Seq Scan or bitmap scan there.
- A session's first skip scan per column type shows "✗ Replay doesn’t match Postgres" on buffer hits, with the note. Removing the mismatch would mean measuring catalog reads during execution, or warming the catalog caches first; left for later.
- The port follows Postgres 18.3. A Postgres upgrade that changes nbtree's heuristics shows up as failing tests.

## Alternatives considered
- **One search per list value** (or per distinct value of a skipped column): simple, and wrong whenever nbtree reads on instead of searching, which the first example already does (`id IN (5, 77, 9000)`: 2 searches, not 3).
- **Infer the searches from the matching rows:** can't say which pages a search read on the way, nor reproduce the read-on-or-search choice, which depends on high keys.
- **Compare values in TypeScript:** fewer queries, but re-implements SQL semantics (collations, cross-type comparisons), which [ADR 0004](0004-pglite-plus-replay-engine.md) rules out.
- **Ask Postgres per comparison:** exact, but tens of thousands of queries for a skip scan over a big index.
- **Port `_bt_set_startikey` too:** more code, and it decides nothing about which pages are read.
