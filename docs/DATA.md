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

All single-table, matching v1 scope, and all in the editor's **Examples** menu ([ADR 0041](decisions/0041-examples-menu.md)). Their SQL, descriptions and expected plans live in `src/examples.ts`; every plan below was checked against Postgres 18 on a fresh database (seed version 1), and `src/examples.test.ts` checks them on every change, each example on a fresh database, again on the same one, and all 12 in order and then in reverse. "Pages" are heap and index pages read, each counted once. The planner's estimates aren't quoted (except example 7's guess): other examples' VACUUM and ANALYZE move them.

| # | Concept | Query or sequence | Plan Postgres picks (checked) |
|---|---|---|---|
| 1 | Primary-key lookup | `orders WHERE id = 4242` | Index Scan using `orders_pkey`: 2 index pages (root, leaf), 1 heap page, 1 row |
| 2 | No usable index | `DROP INDEX IF EXISTS order_items_product_id_idx` (example 3's), then `order_items WHERE product_id = 42` | Seq Scan on `order_items` over all 1,278 heap pages: 189 rows, 200,393 removed by the filter |
| 3 | Adding an index changes the plan | `DROP INDEX IF EXISTS order_items_product_id_idx`; example 2's query; `CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items (product_id)`; the query again | Seq Scan over 1,278 heap pages → Bitmap Heap Scan over a Bitmap Index Scan on `order_items_product_id_idx`: 2 index pages, 177 heap pages, 189 rows |
| 4 | Range scan | `orders WHERE id BETWEEN 1000 AND 2000` | Index Scan using `orders_pkey`, one search then along the leaves: 5 index pages (root and 4 leaves), 13 heap pages, 1,001 rows |
| 5 | Selectivity | `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`; `status = 'pending'`; `status = 'delivered'` | Index Scan using `orders_status_idx` for the rare value: 1,498 rows on 18 heap pages (pending orders are the newest, at the table's end), 3 index pages; Seq Scan over all 589 heap pages for the common one: 45,000 rows |
| 6 | Bitmap scan | `orders WHERE customer_id BETWEEN 100 AND 300` | Bitmap Heap Scan over a Bitmap Index Scan on `orders_customer_id_order_date_idx`: 944 rows marked in the bitmap from 4 index pages, then each of their 480 heap pages read once, in physical order |
| 7 | Functions hide columns | `DROP INDEX IF EXISTS customers_lower_idx`; `customers WHERE lower(email) = 'angela.hawkins42@example.com'`; `CREATE INDEX IF NOT EXISTS customers_lower_idx ON customers (lower(email))`; the query; `ANALYZE customers`; the query | Seq Scan over all 126 heap pages for 1 row (9,999 removed by the filter: the index on `email` can't be used) → Bitmap Heap Scan over a Bitmap Index Scan on `customers_lower_idx` (no statistics on `lower(email)` until ANALYZE: Postgres guesses 50 rows) → Index Scan using `customers_lower_idx` (estimate 1): 2 index pages and 1 heap page each |
| 8 | Column order in a multi-column index | `customers WHERE last_name = 'Hawkins'` vs. `WHERE first_name = 'Angela'` | Bitmap Heap Scan over a Bitmap Index Scan on `customers_last_name_first_name_idx` for the leading column: 38 rows on 32 heap pages, 2 index pages vs. a Seq Scan over all 126 heap pages for the second column: 41 rows (Postgres 18 only skip-scans it with Seq Scans and bitmap scans turned off) |
| 9 | Index Only Scan and the visibility map | `SELECT order_date FROM orders WHERE customer_id = 335`; `UPDATE orders SET total = total WHERE customer_id = 335`; the query twice; `VACUUM orders`; the query | Index Only Scan on `orders_customer_id_order_date_idx`, 3 rows, 2 index pages each time: heap fetches 0 → 6 (old and new versions' entries; 4 heap pages) → 3 (the old ones were marked dead; 1 heap page) → 0. Run again, the UPDATE is a HOT update (the rows' page has room): 0 → 3 → 3 → 0. Customer 335's orders are read by no other example, so moving them changes no other example's pages |
| 10 | Top-N | `WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3` vs. `ORDER BY total DESC LIMIT 10` | Limit over an Index Scan Backward on `orders_customer_id_order_date_idx`, no Sort: 2 index pages (root, one leaf) and 3 heap pages, then the Limit has its 3 rows and stops the scan, vs. Limit over a Sort (a quicksort of the customer's 3 orders) over a bitmap scan: 2 index pages, 3 heap pages |
| 11 | Tiny tables | `categories WHERE id = 3` | Seq Scan over its 1 heap page despite the primary key: 1 row, 11 removed by the filter |
| 12 | Clustering factor | `orders WHERE id BETWEEN 1 AND 500` vs. `WHERE customer_id BETWEEN 1 AND 100` | Index Scan using `orders_pkey` over 6 heap pages for 500 rows (3 index pages) vs. a bitmap scan over 312 heap pages for 468 rows (3 index pages; an Index Scan of the latter reads the same 312 and comes back to them 154 times) |
