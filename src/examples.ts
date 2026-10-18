/*
 * The Examples menu's ready-made queries: one concept from SQL Performance
 * Explained each (docs/DATA.md#example-queries-v1, and v2's as their
 * milestones animate them). The menu, the tests
 * (src/examples.test.ts, e2e/exit-criteria.spec.ts) and the docs all read
 * these definitions, so they agree.
 *
 * Every number here was checked against Postgres on the sample data, and the
 * tests check it again: Postgres picks each plan, and the replay matches.
 * Plain data and text: nothing here talks to Postgres or the browser.
 */

/** What Postgres does with a query on the sample data as it starts. The tests check every field. */
export interface ExpectedPlan {
  /**
   * The plan's node headings as text EXPLAIN writes them, outermost first,
   * depth first (a join's outer side before its inner side), e.g.
   * ["Limit", "Index Scan Backward using orders_customer_id_order_date_idx on orders"].
   */
  plan: string[]
  /**
   * Each node's depth in the plan, 0 for the top, when the plan isn't a
   * chain (a join has two children). Absent for a chain, where each node is
   * one deeper than the one before.
   */
  depths?: number[]
  /** Rows in the result. */
  rows: number
  /** Heap pages the query goes through (reads or finds in shared buffers), if the example talks about them. */
  heapPages?: number
  /**
   * For an Index Only Scan: its Heap Fetches the first time the example runs
   * on a database, and when it runs again (example 9's UPDATE is a HOT update
   * the second time round, see there).
   */
  heapFetches?: { first: number; again: number }
}

export interface ExampleStep {
  /** What the statement does or what to look for, written as a comment above it. No numbers: those come from `expect`. */
  note: string
  /** One statement, on one line, without its semicolon. */
  sql: string
  /** For a query: the plan Postgres picks. Absent for the other statements (CREATE INDEX, UPDATE, ...). */
  expect?: ExpectedPlan
}

export interface Example {
  /** The number docs/DATA.md gives it. */
  id: number
  /** The concept it shows, e.g. "Primary-key lookup". */
  title: string
  /** One or two sentences: what to watch for. Shown in the menu and at the top of the editor text. */
  description: string
  steps: ExampleStep[]
}

const CUSTOMER_EMAIL = 'angela.hawkins42@example.com'

/*
 * Example 9 updates and vacuums one customer's orders, which moves their
 * rows. Customer 345's three orders (ids 11419, 32571 and 44929, on heap
 * pages 134, 384 and 530, all delivered) are rows no other example reads, so
 * running example 9 leaves every other example's numbers as they were.
 */
const IOS_CUSTOMER = 345

export const EXAMPLES: Example[] = [
  {
    id: 1,
    title: 'Primary-key lookup',
    description:
      'Postgres walks down the primary key’s B-tree from the root to one leaf, then fetches the one heap row its entry points at.',
    steps: [
      {
        note: 'Watch the index zone: root, then leaf, then an arrow to the row.',
        sql: 'SELECT * FROM orders WHERE id = 4242',
        expect: { plan: ['Index Scan using orders_pkey on orders'], rows: 1, heapPages: 1 },
      },
    ],
  },
  {
    id: 2,
    title: 'No usable index',
    description:
      'order_items has no index on product_id, so Postgres reads every page of the biggest table and checks every row against the filter.',
    steps: [
      {
        note: 'Almost every row is filtered out (red); a handful go to the result.',
        sql: 'SELECT * FROM order_items WHERE product_id = 42',
        expect: { plan: ['Seq Scan on order_items'], rows: 189, heapPages: 1278 },
      },
    ],
  },
  {
    id: 3,
    title: 'Adding an index changes the plan',
    description:
      'Example 2’s query again, before and after an index on product_id: the Seq Scan over the whole table becomes a bitmap scan that reads only the pages holding matching rows.',
    steps: [
      {
        note: 'Start without the index, in case an earlier run left it behind.',
        sql: 'DROP INDEX IF EXISTS order_items_product_id_idx',
      },
      {
        note: 'No index on product_id yet: the same Seq Scan as example 2.',
        sql: 'SELECT * FROM order_items WHERE product_id = 42',
        expect: { plan: ['Seq Scan on order_items'], rows: 189, heapPages: 1278 },
      },
      {
        note: 'Add the index.',
        sql: 'CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items (product_id)',
      },
      {
        note: 'The same query: the index marks the matching rows in a bitmap (violet), then the heap scan reads just their pages, in physical order.',
        sql: 'SELECT * FROM order_items WHERE product_id = 42',
        expect: {
          plan: ['Bitmap Heap Scan on order_items', 'Bitmap Index Scan on order_items_product_id_idx'],
          rows: 189,
          heapPages: 177,
        },
      },
      {
        note: 'Tidy up, so example 2 finds no index again.',
        sql: 'DROP INDEX order_items_product_id_idx',
      },
    ],
  },
  {
    id: 4,
    title: 'Range scan',
    description:
      'Postgres searches down the primary key once, for the first id in the range, then walks the leaf pages sideways until the ids pass the end of it.',
    steps: [
      {
        note: 'Orders are stored in id order, so the rows come from a few neighbouring heap pages.',
        sql: 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000',
        expect: { plan: ['Index Scan using orders_pkey on orders'], rows: 1001, heapPages: 13 },
      },
    ],
  },
  {
    id: 5,
    title: 'Selectivity',
    description:
      'The same index on status, two values: for a rare status Postgres uses it, for one that most rows have it reads the whole table instead.',
    steps: [
      {
        note: 'Add an index on status (if it isn’t there already).',
        sql: 'CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)',
      },
      {
        note: 'Few orders are pending: an Index Scan.',
        sql: "SELECT * FROM orders WHERE status = 'pending'",
        expect: { plan: ['Index Scan using orders_status_idx on orders'], rows: 1498, heapPages: 18 },
      },
      {
        note: 'Most orders are delivered: reading every page in order is cheaper than jumping around for each row, so a Seq Scan.',
        sql: "SELECT * FROM orders WHERE status = 'delivered'",
        expect: { plan: ['Seq Scan on orders'], rows: 45000, heapPages: 589 },
      },
      {
        note: 'Tidy up: the other examples expect orders without this index.',
        sql: 'DROP INDEX orders_status_idx',
      },
    ],
  },
  {
    id: 6,
    title: 'Bitmap scan',
    description:
      'A range of customers whose orders are scattered across the table: Postgres first marks every matching row in a bitmap, then reads each of their heap pages once, in physical order.',
    steps: [
      {
        note: 'Watch the mini-map: the index scan turns pages violet, then the heap scan sweeps through them.',
        sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300',
        expect: {
          plan: ['Bitmap Heap Scan on orders', 'Bitmap Index Scan on orders_customer_id_order_date_idx'],
          rows: 944,
          heapPages: 480,
        },
      },
    ],
  },
  {
    id: 7,
    title: 'Functions hide columns',
    description:
      'The index on email can’t help a search on lower(email), so Postgres reads the whole table. An index on lower(email) itself can, and once ANALYZE gives Postgres statistics on it, it plans for one row.',
    steps: [
      {
        note: 'Start without the expression index, in case an earlier run left it behind.',
        sql: 'DROP INDEX IF EXISTS customers_lower_email_idx',
      },
      {
        note: 'The index on email holds email, not lower(email): a Seq Scan for one row.',
        sql: `SELECT * FROM customers WHERE lower(email) = '${CUSTOMER_EMAIL}'`,
        expect: { plan: ['Seq Scan on customers'], rows: 1, heapPages: 126 },
      },
      {
        note: 'Index the expression itself.',
        sql: 'CREATE INDEX IF NOT EXISTS customers_lower_email_idx ON customers (lower(email))',
      },
      {
        note: 'Postgres has no statistics on lower(email) yet and guesses 50 rows (see est. in the plan), so it plans a bitmap scan.',
        sql: `SELECT * FROM customers WHERE lower(email) = '${CUSTOMER_EMAIL}'`,
        expect: {
          plan: ['Bitmap Heap Scan on customers', 'Bitmap Index Scan on customers_lower_email_idx'],
          rows: 1,
          heapPages: 1,
        },
      },
      {
        note: 'Gather statistics, including on the indexed expression.',
        sql: 'ANALYZE customers',
      },
      {
        note: 'Now it expects one row: a plain Index Scan.',
        sql: `SELECT * FROM customers WHERE lower(email) = '${CUSTOMER_EMAIL}'`,
        expect: { plan: ['Index Scan using customers_lower_email_idx on customers'], rows: 1, heapPages: 1 },
      },
      {
        note: 'Tidy up, so the first query reads the whole table again next time.',
        sql: 'DROP INDEX customers_lower_email_idx',
      },
    ],
  },
  {
    id: 8,
    title: 'Column order in a multi-column index',
    description:
      'The index on (last_name, first_name) is sorted by last name first, like a phone book: it finds a last name with one search, but a first name is spread all over it.',
    steps: [
      {
        note: 'The leading column: one search down the index, then a bitmap scan of the rows’ pages.',
        sql: "SELECT * FROM customers WHERE last_name = 'Hawkins'",
        expect: {
          plan: ['Bitmap Heap Scan on customers', 'Bitmap Index Scan on customers_last_name_first_name_idx'],
          rows: 38,
          heapPages: 32,
        },
      },
      {
        note: 'The second column alone: Postgres reads the whole table instead. (Postgres 18 can skip-scan the index for it, but here it judges a Seq Scan cheaper.)',
        sql: "SELECT * FROM customers WHERE first_name = 'Angela'",
        expect: { plan: ['Seq Scan on customers'], rows: 41, heapPages: 126 },
      },
    ],
  },
  {
    id: 9,
    title: 'Index Only Scan and the visibility map',
    description:
      'The index holds every column the query needs, so Postgres can skip the heap, but only for pages the visibility map marks all-visible. Watch Heap Fetches in the plan as an UPDATE clears the marks and VACUUM sets them again.',
    steps: [
      {
        note: 'Every page is all-visible: the rows come from the index alone.',
        sql: `SELECT order_date FROM orders WHERE customer_id = ${IOS_CUSTOMER}`,
        expect: {
          plan: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapFetches: { first: 0, again: 0 },
        },
      },
      {
        note: 'Write new versions of the customer’s orders (the values stay the same). Their pages are no longer all-visible.',
        sql: `UPDATE orders SET total = total WHERE customer_id = ${IOS_CUSTOMER}`,
      },
      {
        note: 'The scan has to check the heap. The first time, the pages were full, so each new version went to another page and got index entries of its own: old and new entries are fetched. The scan marks the old ones dead as it goes. When the example runs again, VACUUM has made room, so the new versions stay on their pages (a HOT update) and keep the old entries.',
        sql: `SELECT order_date FROM orders WHERE customer_id = ${IOS_CUSTOMER}`,
        expect: {
          plan: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapFetches: { first: 6, again: 3 },
        },
      },
      {
        note: 'Again: entries the last scan marked dead are skipped, but the pages still aren’t all-visible.',
        sql: `SELECT order_date FROM orders WHERE customer_id = ${IOS_CUSTOMER}`,
        expect: {
          plan: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapFetches: { first: 3, again: 3 },
        },
      },
      {
        note: 'VACUUM removes the old versions and marks the pages all-visible again.',
        sql: 'VACUUM orders',
      },
      {
        note: 'Back to the index alone.',
        sql: `SELECT order_date FROM orders WHERE customer_id = ${IOS_CUSTOMER}`,
        expect: {
          plan: ['Index Only Scan using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapFetches: { first: 0, again: 0 },
        },
      },
    ],
  },
  {
    id: 10,
    title: 'Top-N',
    description:
      'With an index in the ORDER BY’s order, Postgres reads the newest rows first and the Limit stops it after 3. Order by a column the index doesn’t have, and every matching row must be fetched and sorted first.',
    steps: [
      {
        note: 'The index on (customer_id, order_date) read backward gives the newest orders first: no Sort, and the Limit stops the scan.',
        sql: 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3',
        expect: {
          plan: ['Limit', 'Index Scan Backward using orders_customer_id_order_date_idx on orders'],
          rows: 3,
          heapPages: 3,
        },
      },
      {
        note: 'The index isn’t sorted by total: a bitmap scan fetches every one of the customer’s orders and a Sort (violet) orders them before the Limit.',
        sql: 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY total DESC LIMIT 10',
        expect: {
          plan: ['Limit', 'Sort', 'Bitmap Heap Scan on orders', 'Bitmap Index Scan on orders_customer_id_order_date_idx'],
          rows: 3,
          heapPages: 3,
        },
      },
    ],
  },
  {
    id: 11,
    title: 'Tiny tables',
    description:
      'categories fits on one page, so reading that page is cheaper than walking the primary key first: a Seq Scan, despite the index.',
    steps: [
      {
        note: 'One heap page; the filter rejects every row but one.',
        sql: 'SELECT * FROM categories WHERE id = 3',
        expect: { plan: ['Seq Scan on categories'], rows: 1, heapPages: 1 },
      },
    ],
  },
  {
    id: 12,
    title: 'Clustering factor',
    description:
      'Two queries returning about as many rows, through indexes of the same size: rows stored in index order sit on a few pages, rows scattered across the table need a page each.',
    steps: [
      {
        note: 'Orders are stored in id order: neighbouring ids share heap pages.',
        sql: 'SELECT * FROM orders WHERE id BETWEEN 1 AND 500',
        expect: { plan: ['Index Scan using orders_pkey on orders'], rows: 500, heapPages: 6 },
      },
      {
        note: 'A customer’s orders are scattered: nearly every row is on a page of its own, so Postgres uses a bitmap to read each page once.',
        sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100',
        expect: {
          plan: ['Bitmap Heap Scan on orders', 'Bitmap Index Scan on orders_customer_id_order_date_idx'],
          rows: 468,
          heapPages: 312,
        },
      },
    ],
  },
  {
    id: 13,
    title: 'Nested loop join',
    description:
      'For each customer named Hawkins, Postgres searches the index on orders again, for that customer’s id: the inner side of the join runs once per outer row.',
    steps: [
      {
        note: 'A bitmap scan finds the customers (the outer side). For each one, the Nested Loop runs the Index Scan on orders again, with the customer’s id in its Index Cond.',
        sql: `SELECT c.first_name, c.last_name, o.id, o.order_date FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.last_name = 'Hawkins'`,
        expect: {
          plan: [
            'Nested Loop',
            'Bitmap Heap Scan on customers c',
            'Bitmap Index Scan on customers_last_name_first_name_idx',
            'Index Scan using orders_customer_id_order_date_idx on orders o',
          ],
          depths: [0, 1, 2, 1],
          rows: 197,
          heapPages: 202,
        },
      },
    ],
  },
]

/**
 * The text the editor gets when a visitor picks an example: its title and
 * description as comments, then each statement under a comment saying what to
 * look for and the plan to expect. Each comment is one line per paragraph:
 * the editor wraps long lines to the pane's width. `cursor` is where the
 * first statement starts, so Run (Cmd/Ctrl+Enter) runs it.
 */
export function exampleEditorText(example: Example): { text: string; cursor: number } {
  const multiStep = example.steps.length > 1
  const header = [
    `-- Example ${example.id}: ${example.title}`,
    `-- ${example.description}`,
    multiStep
      ? '-- Run the statements one at a time, top to bottom: put the cursor on one and press Cmd/Ctrl+Enter.'
      : '-- Run it with Cmd/Ctrl+Enter.',
    '-- The expected plans are for the sample data as it starts. If your own changes get in the way, Reset database restores it.',
  ]
  let text = header.join('\n') + '\n'
  let cursor = -1
  example.steps.forEach((step, index) => {
    const lines = [multiStep ? `-- ${index + 1}. ${step.note}` : `-- ${step.note}`]
    if (step.expect) lines.push(...expectedPlanComment(step.expect))
    text += '\n' + lines.join('\n') + '\n'
    if (cursor === -1) cursor = text.length
    text += `${step.sql};\n`
  })
  return { text, cursor }
}

/** "Expected plan (189 rows, 177 heap pages):" and the plan's headings, indented as EXPLAIN does. */
function expectedPlanComment(expect: ExpectedPlan): string[] {
  const facts = [count(expect.rows, 'row')]
  if (expect.heapPages !== undefined) facts.push(count(expect.heapPages, 'heap page'))
  if (expect.heapFetches !== undefined) {
    const { first, again } = expect.heapFetches
    facts.push(first === again ? `Heap Fetches ${first}` : `Heap Fetches ${first}; ${again} on later runs`)
  }
  const nodes = expect.plan.map((title, i) => {
    const depth = expect.depths?.[i] ?? i
    return depth === 0 ? title : `${'      '.repeat(depth - 1)}->  ${title}`
  })
  return [`-- Expected plan (${facts.join(', ')}):`, ...nodes.map((node) => `--   ${node}`)]
}

/** "1 row", "1,278 heap pages". */
export function count(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
}
