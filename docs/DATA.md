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

Exact page counts and B-tree depths are measured in M1 and recorded here.

### Distributions (deliberate, for teaching)

- **`orders.order_date` rises with `orders.id`**, and rows are inserted in that order, so the table is physically in date order (high correlation: index range scans on `id` or `order_date` touch few pages).
- **`orders.customer_id` is random**, so one customer's orders are scattered across the table (low correlation).
- **`orders.status` is lopsided:** 90% `delivered`, 5% `shipped`, 3% `pending`, 2% `cancelled`. Pending and shipped orders are the most recent, as in a real shop.
- **`customers.country` is uneven:** about 40% US, then a long tail.
- **Names** come from a few hundred last names and first names, so a last-name lookup returns tens of rows.

### Determinism

Data is generated in SQL with a fixed random seed (`setseed`), then `VACUUM ANALYZE`d. Every visitor gets identical tables and page layouts, so examples can say "look at page 37". Changing the generator bumps the seed version (see [ARCHITECTURE.md](ARCHITECTURE.md#persistence-and-seeding-worker)).

## Starting indexes

- Primary keys on every table (`order_items` has the composite key `(order_id, line_no)`).
- `UNIQUE (customers.email)`
- `customers (last_name, first_name)`: the "phone book" index.
- `orders (customer_id, order_date)`: "a customer's orders by date".

`order_items.product_id`, `orders.status`, and `orders.order_date` alone are deliberately unindexed, so learners can add those indexes and watch plans change.

## Example queries (v1)

All single-table, matching v1 scope. The "expected plan" column is a hypothesis; each example's description is finalized in M3 after checking the plan Postgres actually picks.

| # | Concept | Query sketch | Expected plan |
|---|---|---|---|
| 1 | Primary-key lookup | `orders WHERE id = 4242` | Index Scan: walk down the B-tree, then fetch one heap row |
| 2 | No usable index | `order_items WHERE product_id = 42` | Seq Scan over the big table |
| 3 | Adding an index changes the plan | `CREATE INDEX ON order_items (product_id)`, rerun #2 | Bitmap or Index Scan |
| 4 | Range scan | `orders WHERE id BETWEEN 1000 AND 2000` | Index Scan walking leaf pages sideways |
| 5 | Selectivity | Index `orders(status)`; `'pending'` vs. `'delivered'` | Index for the rare value; Seq Scan for the common one |
| 6 | Bitmap scan | `orders WHERE customer_id BETWEEN 100 AND 300` | Bitmap Index Scan + Bitmap Heap Scan (each heap page read once, in physical order) |
| 7 | Functions hide columns | `customers WHERE lower(email) = '…'`, then an expression index | Seq Scan → Index Scan |
| 8 | Column order in a multi-column index | `WHERE last_name = …` vs. `WHERE first_name = …` | Index Scan vs. Seq Scan, or Postgres 18 skip scan |
| 9 | Index Only Scan and the visibility map | `SELECT order_date FROM orders WHERE customer_id = 42`; update those rows; `VACUUM` | Index Only Scan with heap fetches 0 → >0 → 0 |
| 10 | Top-N | `WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3` vs. `ORDER BY total DESC LIMIT 10` | Backward index scan with no sort vs. Sort |
| 11 | Tiny tables | `categories WHERE id = 3` | Seq Scan despite the primary key |
| 12 | Clustering factor | `orders WHERE id BETWEEN 1 AND 500` vs. `WHERE customer_id BETWEEN 1 AND 100` | Similar row counts; a handful of heap pages vs. hundreds |
