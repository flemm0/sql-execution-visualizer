# 0006: Online-store seed data, deterministic, with two compound indexes

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Learners need a familiar dataset that supports the v1 examples now and 3+ table joins in v2.

## Decision
- An online store: `categories`, `products`, `customers`, `orders`, `order_items`.
- Generated in SQL from a fixed random seed, so every visitor gets identical pages.
- Uneven distributions and deliberate physical clustering, for teaching.
- Starting indexes:
  - primary keys
  - `UNIQUE(customers.email)`
  - `customers (last_name, first_name)`
  - `orders (customer_id, order_date)`

Details: [DATA.md](../DATA.md).

## Consequences
- The two compound indexes enable the column-order, Index Only Scan, and Top-N examples.
- Because `orders.customer_id` is already covered, the "no index / add an index" examples use `order_items.product_id` instead (an unindexed foreign key on the biggest table).

## Alternatives considered
- A schema modeled on the book's examples (employees, sales): closer to the text, less familiar as a domain.
- Primary keys only: fewer ready-made multi-column index lessons.
