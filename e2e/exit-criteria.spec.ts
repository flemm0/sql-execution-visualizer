import { expect, test } from '@playwright/test'
import { openApp, runSql } from './editor'

/*
 * The milestones' exit criteria (docs/ROADMAP.md), as a visitor sees them.
 * CI runs this against the local build on every PR, and the Live check
 * workflow runs it against the deployed site after every deploy.
 */

const M2_EXAMPLES = [
  { example: 1, sql: 'SELECT * FROM orders WHERE id = 4242;', node: 'Index Scan using orders_pkey on orders', rows: '1 row' },
  { example: 2, sql: 'SELECT * FROM order_items WHERE product_id = 42;', node: 'Seq Scan on order_items', rows: '189 rows' },
  { example: 4, sql: 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000;', node: 'Index Scan using orders_pkey on orders', rows: '1,001 rows' },
  { example: 11, sql: 'SELECT * FROM categories WHERE id = 3;', node: 'Seq Scan on categories', rows: '1 row' },
]

test.describe('M2: examples 1, 2, 4 and 11 animate end to end and validate', () => {
  for (const { example, sql, node, rows } of M2_EXAMPLES) {
    test(`example ${example}`, async ({ page }) => {
      await openApp(page)
      await runSql(page, sql)
      await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
      await expect(page.getByTestId('viz-mismatch')).toHaveCount(0)

      await page.getByTestId('player').getByRole('button', { name: 'To the end', exact: true }).click()
      await expect(page.getByTestId('viz-caption')).toHaveText(`${node} has no more rows: it sent ${rows} to the result.`)
      // At the last step the whole result shows.
      await expect(page.getByTestId('rows-filling')).toHaveCount(0)
      await expect(page.getByTestId('run-status')).toContainText(`SELECT: ${rows}`)
    })
  }
})

/**
 * M3's examples, as each one's replay lands; the criteria hold once all 12 are here (and within the ~30 s budget).
 * `setup` runs first, as its own run: the index an example adds.
 */
const M3_EXAMPLES = [
  {
    name: 'example 3: once order_items has an index on product_id, a bitmap scan',
    setup: 'CREATE INDEX ON order_items (product_id);',
    sql: 'SELECT * FROM order_items WHERE product_id = 42;',
    node: 'Bitmap Heap Scan on order_items',
    rows: '189 rows',
  },
  {
    name: 'example 5: a rare status, an Index Scan',
    setup: 'CREATE INDEX ON orders (status);',
    sql: `SELECT * FROM orders WHERE status = 'pending';`,
    node: 'Index Scan using orders_status_idx on orders',
    rows: '1,498 rows',
  },
  {
    name: 'example 5: a common status, a Seq Scan',
    setup: 'CREATE INDEX ON orders (status);',
    sql: `SELECT * FROM orders WHERE status = 'delivered';`,
    node: 'Seq Scan on orders',
    rows: '45,000 rows',
  },
  {
    name: 'example 6: a bitmap scan',
    sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300;',
    node: 'Bitmap Heap Scan on orders',
    rows: '944 rows',
  },
  {
    name: 'example 7: lower(email) hides the column from its index, a Seq Scan',
    sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com';`,
    node: 'Seq Scan on customers',
    rows: '1 row',
  },
  {
    // Until ANALYZE, Postgres has no statistics on lower(email) and guesses 50 rows.
    name: 'example 7: with an index on lower(email), a bitmap scan',
    setup: 'CREATE INDEX ON customers (lower(email));',
    sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com';`,
    node: 'Bitmap Heap Scan on customers',
    rows: '1 row',
  },
  {
    name: 'example 7: with an index on lower(email) and its statistics, an Index Scan',
    setup: 'CREATE INDEX ON customers (lower(email)); ANALYZE customers;',
    sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com';`,
    node: 'Index Scan using customers_lower_idx on customers',
    rows: '1 row',
  },
  {
    name: 'example 8: the index’s leading column, a bitmap scan',
    sql: `SELECT * FROM customers WHERE last_name = 'Hawkins';`,
    node: 'Bitmap Heap Scan on customers',
    rows: '38 rows',
  },
  {
    name: 'example 8: the index’s second column, a Seq Scan',
    sql: `SELECT * FROM customers WHERE first_name = 'Angela';`,
    node: 'Seq Scan on customers',
    rows: '41 rows',
  },
  {
    name: 'example 9: an index-only scan',
    sql: 'SELECT order_date FROM orders WHERE customer_id = 42;',
    node: 'Index Only Scan using orders_customer_id_order_date_idx on orders',
    rows: '3 rows',
  },
  {
    name: 'example 12: ids in the table’s order, an Index Scan',
    sql: 'SELECT * FROM orders WHERE id BETWEEN 1 AND 500;',
    node: 'Index Scan using orders_pkey on orders',
    rows: '500 rows',
  },
  {
    name: 'example 12: customers scattered across the table, a bitmap scan',
    sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100;',
    node: 'Bitmap Heap Scan on orders',
    rows: '468 rows',
  },
]

test.describe('M3: the examples animate end to end and validate', () => {
  for (const { name, setup, sql, node, rows } of M3_EXAMPLES) {
    test(name, async ({ page }) => {
      await openApp(page)
      if (setup !== undefined) await runSql(page, setup)
      await runSql(page, sql)
      await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
      await expect(page.getByTestId('viz-mismatch')).toHaveCount(0)

      await page.getByTestId('player').getByRole('button', { name: 'To the end', exact: true }).click()
      await expect(page.getByTestId('viz-caption')).toHaveText(`${node} has no more rows: it sent ${rows} to the result.`)
      await expect(page.getByTestId('rows-filling')).toHaveCount(0)
      await expect(page.getByTestId('run-status')).toContainText(`SELECT: ${rows}`)
    })
  }
})
