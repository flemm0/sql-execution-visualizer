/*
 * The Examples menu's queries (docs/DATA.md#example-queries-v1), one concept
 * from SQL Performance Explained each. The menu, the tests and the docs all
 * read them from here.
 *
 * Every number in a description or note is real: what Postgres does with the
 * query on a fresh database. src/examples.test.ts runs every example and
 * checks each query's plan against its `plan`, and that the prose quotes no
 * number the plan doesn't check.
 */

/** What Postgres does with one of an example's queries on a fresh database. */
export interface ExpectedPlan {
  /** Every plan node's heading as in text EXPLAIN, outermost first, depth first. */
  nodes: string[]
  /** Rows the query returns. */
  rows: number
  /** Heap (table) pages the query reads, each counted once. */
  heapPages: number
  /** Index pages the query reads, each counted once. */
  indexPages: number
  /** The top node's row estimate, when the example talks about it. */
  estimatedRows?: number
  /** Rows the scan's Filter removed, when the example talks about it. */
  rowsRemovedByFilter?: number
  /** An Index Only Scan's heap fetches. */
  heapFetches?: number
  /** A Sort's method, e.g. "quicksort". */
  sortMethod?: string
  /**
   * What differs when the example runs again on the same database, for the
   * few numbers that do (example 9's UPDATE leaves its rows on a page with
   * room, so the next UPDATE is a HOT update).
   */
  again?: Partial<Omit<ExpectedPlan, 'again'>>
}

/** One statement of an example, run on its own. */
export interface ExampleStep {
  /** What the step does, or what to watch for: a comment above it in the editor. */
  note: string
  /** One statement, without its semicolon. */
  sql: string
  /** For a query, the plan Postgres picks; absent for other statements. */
  plan?: ExpectedPlan
}

export interface Example {
  /** Its number in docs/DATA.md, 1 to 12. */
  number: number
  /** The concept it demonstrates. */
  title: string
  /** What to watch for, in a sentence or two. */
  description: string
  /** Its statements, in the order to run them. */
  steps: ExampleStep[]
}

export const EXAMPLES: Example[] = [
  {
    number: 1,
    title: 'Primary-key lookup',
    description:
      'Postgres walks down the primary key’s B-tree from the root to one leaf, then fetches the one matching row from the heap: 2 index pages and 1 heap page.',
    steps: [
      {
        note: 'One order, by its primary key.',
        sql: 'SELECT * FROM orders WHERE id = 4242',
        plan: { nodes: ['Index Scan using orders_pkey on orders'], rows: 1, heapPages: 1, indexPages: 2 },
      },
    ],
  },
  {
    number: 2,
    title: 'No usable index',
    description:
      'Nothing indexes order_items.product_id, so Postgres reads all 1,278 heap pages of the biggest table to find 189 rows; the filter removes the other 200,393.',
    steps: [
      {
        note: 'Example 3 adds an index on product_id. Drop it if it’s there, so there’s none to use.',
        sql: 'DROP INDEX IF EXISTS order_items_product_id_idx',
      },
      {
        note: 'One product’s order lines.',
        sql: 'SELECT * FROM order_items WHERE product_id = 42',
        plan: {
          nodes: ['Seq Scan on order_items'],
          rows: 189,
          heapPages: 1278,
          indexPages: 0,
          rowsRemovedByFilter: 200393,
        },
      },
    ],
  },
  {
    number: 3,
    title: 'Adding an index changes the plan',
    description:
      'Without an index, example 2’s query reads all 1,278 heap pages. Once product_id is indexed, Postgres switches to a bitmap scan: 2 index pages, then only the 177 heap pages that hold the 189 rows.',
    steps: [
      {
        note: 'Start without the index this example adds.',
        sql: 'DROP INDEX IF EXISTS order_items_product_id_idx',
      },
      {
        note: 'No index on product_id: a Seq Scan over the whole table.',
        sql: 'SELECT * FROM order_items WHERE product_id = 42',
        plan: { nodes: ['Seq Scan on order_items'], rows: 189, heapPages: 1278, indexPages: 0 },
      },
      {
        note: 'Index product_id.',
        sql: 'CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items (product_id)',
      },
      {
        note: 'The same query again: a Bitmap Index Scan, then a Bitmap Heap Scan of only the pages it marked.',
        sql: 'SELECT * FROM order_items WHERE product_id = 42',
        plan: {
          nodes: ['Bitmap Heap Scan on order_items', 'Bitmap Index Scan on order_items_product_id_idx'],
          rows: 189,
          heapPages: 177,
          indexPages: 2,
        },
      },
    ],
  },
  {
    number: 4,
    title: 'Range scan',
    description:
      'Postgres goes down the primary key once, to the leaf holding id 1000, then walks along the leaves to the right until it passes 2000: 5 index pages. The table is in id order, so the 1,001 rows sit on just 13 heap pages.',
    steps: [
      {
        note: 'A range of orders, by primary key.',
        sql: 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000',
        plan: { nodes: ['Index Scan using orders_pkey on orders'], rows: 1001, heapPages: 13, indexPages: 5 },
      },
    ],
  },
  {
    number: 5,
    title: 'Selectivity',
    description:
      'With an index on status, the rare ‘pending’ gets an Index Scan: 1,498 rows on 18 heap pages. The common ‘delivered’ (45,000 rows) gets a Seq Scan of all 589 pages: fetching most of the table through an index would cost more.',
    steps: [
      {
        note: 'Index status.',
        sql: 'CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)',
      },
      {
        note: 'A rare status. Pending orders are the newest, so they sit together at the end of the table.',
        sql: `SELECT * FROM orders WHERE status = 'pending'`,
        plan: { nodes: ['Index Scan using orders_status_idx on orders'], rows: 1498, heapPages: 18, indexPages: 3 },
      },
      {
        note: 'A common status: the same index, but Postgres doesn’t use it.',
        sql: `SELECT * FROM orders WHERE status = 'delivered'`,
        plan: { nodes: ['Seq Scan on orders'], rows: 45000, heapPages: 589, indexPages: 0 },
      },
    ],
  },
  {
    number: 6,
    title: 'Bitmap scan',
    description:
      'Customers’ orders are scattered across the table, so Postgres first marks the 944 matching rows in a bitmap from the index, then reads each of their 480 heap pages once, in physical order.',
    steps: [
      {
        note: 'Customers 100 to 300’s orders.',
        sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300',
        plan: {
          nodes: ['Bitmap Heap Scan on orders', 'Bitmap Index Scan on orders_customer_id_order_date_idx'],
          rows: 944,
          heapPages: 480,
          indexPages: 4,
        },
      },
    ],
  },
  {
    number: 7,
    title: 'Functions hide columns',
    description:
      'The index on email can’t find lower(email), so Postgres reads all 126 heap pages for 1 row. An index on lower(email) gives a bitmap scan while Postgres guesses 50 rows, then an Index Scan once ANALYZE gives it statistics.',
    steps: [
      {
        note: 'Start without the index this example adds.',
        sql: 'DROP INDEX IF EXISTS customers_lower_idx',
      },
      {
        note: 'The index on email holds email, not lower(email): a Seq Scan, the filter removing 9,999 rows.',
        sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com'`,
        plan: {
          nodes: ['Seq Scan on customers'],
          rows: 1,
          heapPages: 126,
          indexPages: 0,
          rowsRemovedByFilter: 9999,
        },
      },
      {
        note: 'Index the expression itself.',
        sql: 'CREATE INDEX IF NOT EXISTS customers_lower_idx ON customers (lower(email))',
      },
      {
        note: 'Postgres has no statistics on lower(email) yet and guesses 50 rows, too many for a plain Index Scan.',
        sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com'`,
        plan: {
          nodes: ['Bitmap Heap Scan on customers', 'Bitmap Index Scan on customers_lower_idx'],
          rows: 1,
          heapPages: 1,
          indexPages: 2,
          estimatedRows: 50,
        },
      },
      {
        note: 'ANALYZE gathers statistics on indexed expressions too.',
        sql: 'ANALYZE customers',
      },
      {
        note: 'Now Postgres expects 1 row: an Index Scan, 2 index pages and 1 heap page.',
        sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com'`,
        plan: {
          nodes: ['Index Scan using customers_lower_idx on customers'],
          rows: 1,
          heapPages: 1,
          indexPages: 2,
          estimatedRows: 1,
        },
      },
    ],
  },
  {
    number: 8,
    title: 'Column order in a multi-column index',
    description:
      'The index on (last_name, first_name) is sorted by last name first, like a phone book. A last name is one search down it: 38 rows on 32 heap pages. A first name alone gets a Seq Scan of all 126 heap pages.',
    steps: [
      {
        note: 'The index’s leading column.',
        sql: `SELECT * FROM customers WHERE last_name = 'Hawkins'`,
        plan: {
          nodes: ['Bitmap Heap Scan on customers', 'Bitmap Index Scan on customers_last_name_first_name_idx'],
          rows: 38,
          heapPages: 32,
          indexPages: 2,
        },
      },
      {
        note: 'Its second column: 41 rows, every page read.',
        sql: `SELECT * FROM customers WHERE first_name = 'Angela'`,
        plan: { nodes: ['Seq Scan on customers'], rows: 41, heapPages: 126, indexPages: 0 },
      },
    ],
  },
  {
    number: 9,
    title: 'Index Only Scan and the visibility map',
    description:
      'The index holds every column the query needs, so Postgres skips heap pages the visibility map marks all-visible. Watch the heap fetches: 0, then 6 after an UPDATE, 3 once a scan has marked the old versions’ entries dead, and 0 after VACUUM.',
    steps: [
      {
        note: 'Customer 335’s order dates, from the index alone: 0 heap fetches.',
        sql: 'SELECT order_date FROM orders WHERE customer_id = 335',
        plan: {
          nodes: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapPages: 0,
          indexPages: 2,
          heapFetches: 0,
        },
      },
      {
        note: 'Change the 3 rows. Each gets a new version, and their pages are no longer all-visible.',
        sql: 'UPDATE orders SET total = total WHERE customer_id = 335',
      },
      {
        note: '6 heap fetches: an entry for each row’s old version and one for its new version. The old ones are marked dead.',
        sql: 'SELECT order_date FROM orders WHERE customer_id = 335',
        plan: {
          nodes: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapPages: 4,
          indexPages: 2,
          heapFetches: 6,
          // The rows' page has room now, so the UPDATE was a HOT update: no new entries.
          again: { heapPages: 1, heapFetches: 3 },
        },
      },
      {
        note: '3 heap fetches: the scan skips the dead entries, but the new versions’ page isn’t all-visible yet. (Run again, it’s 3 and 3: the UPDATE fits on its page as a HOT update, with no new index entries.)',
        sql: 'SELECT order_date FROM orders WHERE customer_id = 335',
        plan: {
          nodes: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapPages: 1,
          indexPages: 2,
          heapFetches: 3,
        },
      },
      {
        note: 'VACUUM marks the pages all-visible again.',
        sql: 'VACUUM orders',
      },
      {
        note: 'Back to 0 heap fetches.',
        sql: 'SELECT order_date FROM orders WHERE customer_id = 335',
        plan: {
          nodes: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapPages: 0,
          indexPages: 2,
          heapFetches: 0,
        },
      },
    ],
  },
  {
    number: 10,
    title: 'Top-N',
    description:
      'The index on (customer_id, order_date) keeps each customer’s orders in date order, so the latest 3 come from reading it backward, and the Limit stops the scan: no Sort. Ordering by total needs a Sort of all the customer’s orders first.',
    steps: [
      {
        note: 'The latest 3 orders: an Index Scan Backward, 2 index pages and 3 heap pages.',
        sql: 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3',
        plan: {
          nodes: ['Limit', 'Index Scan Backward using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapPages: 3,
          indexPages: 2,
        },
      },
      {
        note: 'The 10 largest totals: the index isn’t sorted by total, so a quicksort of the customer’s 3 orders.',
        sql: 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY total DESC LIMIT 10',
        plan: {
          nodes: [
            'Limit',
            'Sort',
            'Bitmap Heap Scan on orders',
            'Bitmap Index Scan on orders_customer_id_order_date_idx',
          ],
          rows: 3,
          heapPages: 3,
          indexPages: 2,
          sortMethod: 'quicksort',
        },
      },
    ],
  },
  {
    number: 11,
    title: 'Tiny tables',
    description:
      'categories fits on 1 heap page, so reading it whole is cheaper than walking an index: a Seq Scan despite the primary key, the filter removing 11 rows to keep 1.',
    steps: [
      {
        note: 'One category, by its primary key.',
        sql: 'SELECT * FROM categories WHERE id = 3',
        plan: { nodes: ['Seq Scan on categories'], rows: 1, heapPages: 1, indexPages: 0, rowsRemovedByFilter: 11 },
      },
    ],
  },
  {
    number: 12,
    title: 'Clustering factor',
    description:
      'The table is in id order, so orders 1 to 500 sit together: an Index Scan reads 6 heap pages for 500 rows. Customers 1 to 100’s 468 orders are scattered over 312 heap pages, so Postgres reads them with a bitmap scan, each page once.',
    steps: [
      {
        note: 'Rows next to each other in the table.',
        sql: 'SELECT * FROM orders WHERE id BETWEEN 1 AND 500',
        plan: { nodes: ['Index Scan using orders_pkey on orders'], rows: 500, heapPages: 6, indexPages: 3 },
      },
      {
        note: 'Rows scattered across the table.',
        sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100',
        plan: {
          nodes: ['Bitmap Heap Scan on orders', 'Bitmap Index Scan on orders_customer_id_order_date_idx'],
          rows: 468,
          heapPages: 312,
          indexPages: 3,
        },
      },
    ],
  },
]

/** An example as the editor shows it: its text, and where the cursor goes (the first statement). */
export interface ExampleText {
  text: string
  cursor: number
}

/** Comment lines are wrapped to this width. */
const COMMENT_WIDTH = 70

/**
 * The editor text for an example: a comment with its title and description,
 * how to run it, then each statement under a comment of its own. The cursor
 * goes on the first statement, so Cmd/Ctrl+Enter runs it.
 */
export function exampleText(example: Example): ExampleText {
  const single = example.steps.length === 1
  const header = [
    ...comment(`Example ${example.number}: ${example.title}`),
    '--',
    ...comment(example.description),
    '--',
    ...comment(
      single
        ? 'Press Cmd/Ctrl+Enter (or Run) to run it.'
        : 'Run one statement at a time, in order: click in it and press Cmd/Ctrl+Enter (or Run).',
    ),
    ...comment(
      'The numbers are from a fresh database. If yours differ, your own changes may be why: Reset database brings back the starting data.',
    ),
  ]
  let text = header.join('\n') + '\n'
  let cursor = -1
  example.steps.forEach((step, index) => {
    text += '\n' + comment(single ? step.note : `${index + 1}. ${step.note}`).join('\n') + '\n'
    if (cursor === -1) cursor = text.length
    text += `${step.sql};\n`
  })
  return { text, cursor }
}

/** Wraps text into `--` comment lines of at most COMMENT_WIDTH characters (a longer word gets a line of its own). */
function comment(text: string): string[] {
  const lines: string[] = []
  let line = '--'
  for (const word of text.split(' ')) {
    if (line !== '--' && line.length + 1 + word.length > COMMENT_WIDTH) {
      lines.push(line)
      line = '--'
    }
    line += ' ' + word
  }
  lines.push(line)
  return lines
}
