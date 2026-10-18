# Seed data and examples

## Schema: a small online store

| Table | Rows | Columns (sketch) | Why it's there |
|---|---|---|---|
| `categories` | 12 | `id`, `name`, `description` | Fits on one page: Seq Scan beats an index |
| `products` | 1,000 | `id`, `category_id`, `name`, `price`, `description` (a few hundred bytes), `created_at` | Wide rows, so fewer rows per page |
| `customers` | 10,000 | `id`, `email`, `first_name`, `last_name`, `country`, `city`, `signup_date` | Name lookups, uneven countries |
| `orders` | 50,000 | `id`, `customer_id`, `order_date`, `status`, `total`, `shipping_address` | Clustered vs. scattered access; uneven `status` |
| `order_items` | ~200,000 | `order_id`, `line_no`, `product_id`, `quantity`, `unit_price` | The big table: 3-level B-tree, long Seq Scans |

Foreign keys are declared (`products → categories`, `orders → customers`, `order_items → orders, products`). As in real Postgres, declaring a foreign key does not create an index.

### Measured sizes (seed version 1)

8 kB pages. The whole database, catalogs included, is about 31 MB.

| Table | Rows | Heap pages | Indexes (pages, B-tree levels) |
|---|---|---|---|
| `categories` | 12 | 1 | `categories_pkey` (2, 1 level: the root is the only leaf) |
| `products` | 1,000 | 48 | `products_pkey` (5, 2) |
| `customers` | 10,000 | 126 | `customers_pkey` (30, 2), `customers_email_key` (64, 2), `customers_last_name_first_name_idx` (40, 2) |
| `orders` | 50,000 | 589 | `orders_pkey` (139, 2), `orders_customer_id_order_date_idx` (139, 2) |
| `order_items` | 200,582 | 1,278 | `order_items_pkey` (553, 3) |

Page counts include each index's metapage.

### Distributions (deliberate, for teaching)

- **`orders.order_date` rises with `orders.id`**, and rows are inserted in that order, so the table is physically in date order (high correlation: index range scans on `id` or `order_date` touch few pages).
- **`orders.customer_id` is random**, so one customer's orders are scattered across the table (low correlation).
- **`orders.status` is lopsided:** 90% `delivered`, 5% `shipped`, 3% `pending`, 2% `cancelled`. Pending and shipped orders are the most recent, as in a real shop.
- **`customers.country` is uneven:** about 40% US, then a long tail.
- **Names** come from a few hundred last names and first names, so a last-name lookup returns tens of rows.

### Determinism

Data is generated in SQL (`src/db/seed.ts`) with a fixed random seed (`setseed`), rows inserted in a fixed order, then `VACUUM ANALYZE`d. Indexes and constraints are added after loading, so each B-tree is built in one pass. Every visitor gets identical tables and page layouts, so examples can say "look at page 37". A unit test pins a fingerprint of every row and its `ctid`; changing the generator changes it, and must bump the seed version (see [ARCHITECTURE.md](ARCHITECTURE.md#persistence-and-seeding-worker)). Generation takes about a second.

Other details: `order_date` runs evenly from 2022-01-01 to 2024-12-31; orders have 1 to 7 items; 60% of items have quantity 1; product prices are skewed toward the cheap end ($2 to $500); `orders.total` is the sum of its items. Customers' `signup_date` rises with `id`.

## Starting indexes

- Primary keys on every table (`order_items` has the composite key `(order_id, line_no)`).
- `UNIQUE (customers.email)`
- `customers (last_name, first_name)`: the "phone book" index.
- `orders (customer_id, order_date)`: "a customer's orders by date".

`order_items.product_id`, `orders.status`, and `orders.order_date` alone are deliberately unindexed, so learners can add those indexes and watch plans change.

## Example queries (v1)

All single-table, matching v1 scope. They're defined in one place, `src/examples.ts`, which the **Examples** menu, the editor text, the tests and this table share ([ADR 0041](decisions/0041-examples-menu.md)). Every expected plan below is **checked**: on 2026-10-12 against Postgres 18.3 (PGlite 0.5.8), and again by `src/examples.test.ts` on every test run, on a fresh seed, with all 12 run in order, in reverse and in order again. `e2e/exit-criteria.spec.ts` picks each one from the menu and plays it to the end. "Heap pages" are the pages a query goes through (read, or found in shared buffers).

Examples that add an index drop it again at the end, and examples 3 and 7 start by dropping it if an earlier run left it behind, so each can be repeated and in any order. The plans assume the starting indexes and data; the visitor's own changes can change them, which the editor text says, pointing to **Reset database**.

| # | Concept | Statements | Expected plan (checked) |
|---|---|---|---|
| 1 | Primary-key lookup | `SELECT * FROM orders WHERE id = 4242` | Index Scan using `orders_pkey`: 1 row, 1 heap page |
| 2 | No usable index | `SELECT * FROM order_items WHERE product_id = 42` | Seq Scan on `order_items`: 189 rows, all 1,278 heap pages |
| 3 | Adding an index changes the plan | `DROP INDEX IF EXISTS order_items_product_id_idx`; example 2's query; `CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items (product_id)`; the query again; `DROP INDEX order_items_product_id_idx` | Seq Scan on `order_items` (189 rows, 1,278 heap pages) → Bitmap Heap Scan over a Bitmap Index Scan on `order_items_product_id_idx` (189 rows, 177 heap pages) |
| 4 | Range scan | `SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000` | Index Scan using `orders_pkey`, walking the leaf pages sideways: 1,001 rows, 13 heap pages |
| 5 | Selectivity | `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`; `WHERE status = 'pending'`; `WHERE status = 'delivered'`; `DROP INDEX orders_status_idx` | Index Scan using `orders_status_idx` for the rare value (1,498 rows, 18 heap pages); Seq Scan for the common one (45,000 rows, all 589 heap pages) |
| 6 | Bitmap scan | `SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300` | Bitmap Heap Scan over a Bitmap Index Scan on `orders_customer_id_order_date_idx`: 944 rows marked in the bitmap, then each of their 480 heap pages read once, in physical order |
| 7 | Functions hide columns | `DROP INDEX IF EXISTS customers_lower_email_idx`; `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com'`; `CREATE INDEX IF NOT EXISTS customers_lower_email_idx ON customers (lower(email))`; the query; `ANALYZE customers`; the query; `DROP INDEX customers_lower_email_idx` | Seq Scan over all 126 heap pages for 1 row (the index on `email` can't be used) → Bitmap Heap Scan over a Bitmap Index Scan on `customers_lower_email_idx`, 1 heap page (Postgres has no statistics on `lower(email)` until ANALYZE and guesses 50 rows) → Index Scan using `customers_lower_email_idx` once analyzed, 1 heap page |
| 8 | Column order in a multi-column index | `WHERE last_name = 'Hawkins'`; `WHERE first_name = 'Angela'` | Bitmap Heap Scan over a Bitmap Index Scan on `customers_last_name_first_name_idx` for the leading column: 38 rows on 32 heap pages, one search down the index; Seq Scan over all 126 heap pages for the second column: 41 rows (Postgres 18 could skip-scan the index, but judges the Seq Scan cheaper) |
| 9 | Index Only Scan and the visibility map | `SELECT order_date FROM orders WHERE customer_id = 345`; `UPDATE orders SET total = total WHERE customer_id = 345`; the SELECT twice; `VACUUM orders`; the SELECT | Index Only Scan using `orders_customer_id_order_date_idx`, 3 rows each time. Heap Fetches 0 → 6 (the new versions went to other pages and got index entries of their own, so old and new entries are fetched) → 3 (the scan marked the old entries dead) → 0. Run again, the UPDATE is a HOT update on pages VACUUM made room on: 0 → 3 → 3 → 0. Customer 345's orders (heap pages 134, 384 and 530) are rows no other example reads, so moving them changes no other example |
| 10 | Top-N | `WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3`; `WHERE customer_id = 42 ORDER BY total DESC LIMIT 10` | Limit over an Index Scan Backward on `orders_customer_id_order_date_idx`, no Sort: 3 rows from 3 heap pages, then the Limit stops the scan; Limit over a Sort (quicksort) over a Bitmap Heap Scan and Bitmap Index Scan: the customer's 3 orders from 3 heap pages |
| 11 | Tiny tables | `SELECT * FROM categories WHERE id = 3` | Seq Scan on `categories` despite the primary key: 1 row, its 1 heap page |
| 12 | Clustering factor | `WHERE id BETWEEN 1 AND 500`; `WHERE customer_id BETWEEN 1 AND 100` | Index Scan using `orders_pkey`: 500 rows on 6 heap pages; Bitmap Heap Scan over a Bitmap Index Scan on `orders_customer_id_order_date_idx`: 468 rows on 312 heap pages |

## Example queries (v2)

Joins, aggregates, subqueries and CTEs, on the same seed data and starting indexes. Each one moves into `src/examples.ts`, and so into the **Examples** menu, the editor text and the tests, in the milestone that animates it ([ROADMAP.md](ROADMAP.md#v2-joins-and-intermediate-results)). From then on, `src/examples.test.ts` checks its plan on every test run, as it does for v1's. Until then, each expected plan below was **checked once**: on 2026-10-14, against Postgres 18.3 (PGlite 0.5.8), on a fresh seed, with the statements run in this order. Row counts are the plan's own (`actual rows × loops`). Heap page counts are given where the plan states them (`Heap Blocks`, or a Seq Scan's whole table); each milestone adds the rest from the replay's trace.

Example 14 adds the same index as example 3, under the same name, and tidies up the same way: it drops the index first if it exists, and drops it again at the end. Each "loop" is one run of the inner side of a Nested Loop (or of a SubPlan) for one outer row.

| # | Milestone | Concept | Statements | Expected plan (checked) |
|---|---|---|---|---|
| 13 | M4 | Nested loop join | `SELECT c.first_name, c.last_name, o.id, o.order_date FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.last_name = 'Hawkins'` | Nested Loop. Outer: Bitmap Heap Scan on `customers` over a Bitmap Index Scan on `customers_last_name_first_name_idx`, 38 customers on 32 heap pages. Inner: Index Scan using `orders_customer_id_order_date_idx`, 38 loops with one search down the index each. 197 rows, 202 heap pages of the two tables. In `src/examples.ts` since M4 |
| 14 | M4 | Foreign keys aren't indexed | `DROP INDEX IF EXISTS order_items_product_id_idx`; `SELECT p.name, oi.order_id, oi.quantity FROM products p JOIN order_items oi ON oi.product_id = p.id WHERE p.id = 42`; `CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items (product_id)`; the query again; `DROP INDEX order_items_product_id_idx` | Nested Loop: an Index Scan using `products_pkey` (1 row), then a Seq Scan on `order_items` over all 1,278 heap pages: 189 rows. After the index: the inner side is a Bitmap Heap Scan over a Bitmap Index Scan on `order_items_product_id_idx`, 177 heap pages: 189 rows |
| 15 | M4 | Materialize: a join with no equality | `SELECT a.name, b.name FROM categories a CROSS JOIN categories b WHERE a.id < b.id` | Nested Loop with a Join Filter (`a.id < b.id`). Outer: Seq Scan on `categories a`, 12 rows. Inner: Materialize over a Seq Scan on `categories b`, which runs once; the Materialize hands back its 12 stored rows in each of 12 loops. 144 pairs checked, 78 removed by the Join Filter, 66 rows |
| 16 | M5 | Hash join | `SELECT o.id, o.total, c.country FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_date >= '2024-12-01'` | Hash Join. Hash over a Seq Scan on `customers`: all 10,000 rows from 126 heap pages, 16,384 buckets, 1 batch, 458 kB. Probed by a Seq Scan on `orders` over all 589 heap pages, where 1,414 rows pass the filter. 1,414 rows |
| 17 | M5 | Select only the columns you need | Example 16's query; the same with `c.*` in place of `c.country` | The same plan both times; the Hash's memory grows from 458 kB to 1,002 kB, because it stores every column it outputs |
| 18 | M5 | Join size picks the join method | `SELECT o.id, o.order_date, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id BETWEEN 1000 AND 1009`; the same with `BETWEEN 1000 AND 1999` | 10 orders: Nested Loop, an Index Scan using `orders_pkey` (10 rows), then an Index Scan using `customers_pkey`, 10 loops: 10 rows. 1,000 orders: Hash Join, a Hash over a Seq Scan on `customers` (10,000 rows, 643 kB), probed by an Index Scan using `orders_pkey`: 1,000 rows |
| 19 | M5 | Aggregate | `SELECT count(*) FROM orders WHERE customer_id = 42` | Aggregate over an Index Only Scan using `orders_customer_id_order_date_idx`: 3 entries, Heap Fetches 0, 1 row |
| 20 | M5 | GROUP BY with a hash table | `SELECT status, count(*) FROM orders GROUP BY status` | HashAggregate (Group Key `status`, 1 batch, 32 kB) over a Seq Scan on `orders`: 50,000 rows from all 589 heap pages into 4 groups. 4 rows |
| 21 | M6 | Pipelined GROUP BY | `SELECT customer_id, max(order_date) FROM orders GROUP BY customer_id ORDER BY customer_id LIMIT 10` | Limit over a GroupAggregate over an Index Only Scan using `orders_customer_id_order_date_idx`, no Sort: 10 groups from the first 35 index entries, then the Limit stops the scan. 10 rows |
| 22 | M6 | Merge join | `SELECT o.id, oi.line_no, oi.quantity FROM orders o JOIN order_items oi ON oi.order_id = o.id ORDER BY o.id LIMIT 20` | Limit over a Merge Join (`o.id = oi.order_id`), no Sort. Its inputs: an Index Only Scan using `orders_pkey` (4 rows) and an Index Scan using `order_items_pkey` (20 rows), then the Limit stops both. 20 rows |
| 23 | M7 | A subquery that runs once (InitPlan) | `SELECT id, total FROM orders WHERE customer_id = 42 AND total > (SELECT avg(total) FROM orders WHERE customer_id = 42)` | Bitmap Heap Scan on `orders` over a Bitmap Index Scan on `orders_customer_id_order_date_idx`, filtered by `total > (InitPlan 1)`. InitPlan 1: an Aggregate over its own Bitmap Heap Scan of the customer's 3 orders. 3 rows checked, 1 removed, 2 rows |
| 24 | M7 | A subquery that runs per row (SubPlan) | `SELECT c.id, c.last_name, (SELECT count(*) FROM orders o WHERE o.customer_id = c.id) AS orders FROM customers c WHERE c.last_name = 'Hawkins'` | Bitmap Heap Scan on `customers` over a Bitmap Index Scan on `customers_last_name_first_name_idx` (38 rows, 32 heap pages). SubPlan 1: an Aggregate over an Index Only Scan using `orders_customer_id_order_date_idx`, 38 loops. 38 rows |
| 25 | M7 | EXISTS stops at the first match | `SELECT * FROM customers c WHERE c.last_name = 'Hawkins' AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'pending')` | Nested Loop Semi Join. Outer: Bitmap Heap Scan on `customers` (38 rows). Inner: Index Scan using `orders_customer_id_order_date_idx` with a Filter on `status`, 38 loops. 7 rows |
| 26 | M7 | A LIMIT keeps a subquery whole | `SELECT * FROM (SELECT id, total FROM orders WHERE customer_id = 42 ORDER BY total DESC LIMIT 2) s WHERE s.total > 100` | Subquery Scan on `s` with the outer Filter, over a Limit over a Sort (quicksort) over a Bitmap Heap Scan and a Bitmap Index Scan on `orders_customer_id_order_date_idx`. The filter can't move below the LIMIT. 2 rows |
| 27 | M7 | A CTE, materialized or inlined | `WITH hawkins AS MATERIALIZED (SELECT id, email FROM customers WHERE last_name = 'Hawkins') SELECT h.email, o.id FROM hawkins h JOIN orders o ON o.customer_id = h.id`; the same without `MATERIALIZED` | Materialized: CTE `hawkins`, a Bitmap Heap Scan on `customers` (38 rows, stored in memory, 19 kB), then a Nested Loop over a CTE Scan on it and an Index Scan using `orders_customer_id_order_date_idx`, 38 loops: 197 rows. Inlined: no CTE node; the Bitmap Heap Scan feeds the Nested Loop directly, as in example 13: 197 rows |
| 28 | M7 | Joining four tables | `SELECT c.email, o.id, o.order_date, p.name, oi.quantity FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id WHERE c.email = 'angela.hawkins42@example.com'` | Three Nested Loops. An Index Scan using `customers_email_key` (1 row), then a Bitmap Heap Scan on `orders` (3 rows), then an Index Scan using `order_items_pkey` (3 loops, 10 rows), then an Index Scan using `products_pkey` (10 loops). 10 rows |
| 29 | M7 | Join, then group | `SELECT cat.name, count(*) AS items, sum(oi.quantity) AS quantity FROM categories cat JOIN products p ON p.category_id = cat.id JOIN order_items oi ON oi.product_id = p.id WHERE oi.order_id BETWEEN 1000 AND 1500 GROUP BY cat.name` | HashAggregate (Group Key `cat.name`) over two Hash Joins. A Bitmap Heap Scan on `order_items` over a Bitmap Index Scan on `order_items_pkey` (2,002 rows, 13 heap pages) probes a Hash of all 1,000 `products` (48 heap pages, 36 kB). The joined rows then probe a Hash of the 12 `categories`. 2,002 joined rows into 12 groups |
