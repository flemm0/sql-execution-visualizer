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
