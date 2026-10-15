import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt } from '../db/runner'
import { seedDatabase } from '../db/seed'
import type { Trace } from '../replay/trace'
import { STEP_BUDGET, condense, isStretch, summarize, type Step } from './condense'

/*
 * Every example plays within the ~30 s budget at the default speed (ADR 0005,
 * ADR 0042), condensed from the real trace, and so do much bigger plans of
 * other shapes. One database for all of them: the examples that add an index
 * come last, in the order the Examples menu runs them.
 */

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
}, 120_000)
afterAll(() => db.close())

/** The default speed (DEFAULT_SPEED in usePlayer.ts, which needs a browser), and the tolerance: at most 30 seconds at it. */
const DEFAULT_SPEED = 30
const MAX_SECONDS = 30

interface Example {
  name: string
  sql: string
  /** Run first, as its own statement. */
  setup?: string
  /** Planner settings turned off, to get the plan the case is about. */
  off?: string[]
}

const EXAMPLES: Example[] = [
  { name: 'example 1: a primary-key lookup', sql: 'SELECT * FROM orders WHERE id = 4242' },
  { name: 'example 2: a Seq Scan of order_items', sql: 'SELECT * FROM order_items WHERE product_id = 42' },
  { name: 'example 4: a range scan', sql: 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000' },
  { name: 'example 6: a bitmap scan', sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300' },
  { name: 'example 7: lower(email), a Seq Scan', sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com'` },
  { name: 'example 8: the leading column', sql: `SELECT * FROM customers WHERE last_name = 'Hawkins'` },
  { name: 'example 8: the second column', sql: `SELECT * FROM customers WHERE first_name = 'Angela'` },
  { name: 'example 9: an index-only scan', sql: 'SELECT order_date FROM orders WHERE customer_id = 42' },
  { name: 'example 10: backward, stopped by the Limit', sql: 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3' },
  { name: 'example 10: a Sort under the Limit', sql: 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY total DESC LIMIT 10' },
  { name: 'example 11: a tiny table', sql: 'SELECT * FROM categories WHERE id = 3' },
  { name: 'example 12: ids in the table’s order', sql: 'SELECT * FROM orders WHERE id BETWEEN 1 AND 500' },
  { name: 'example 12: scattered customers, a bitmap scan', sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100' },
  {
    name: 'example 12 as an Index Scan: 312 heap pages, revisited 154 times',
    sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100',
    off: ['enable_bitmapscan', 'enable_seqscan'],
  },
  {
    name: 'example 7: an index on lower(email), a bitmap scan',
    setup: 'CREATE INDEX ON customers (lower(email))',
    sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com'`,
  },
  {
    name: 'example 7: with statistics, an Index Scan',
    setup: 'ANALYZE customers',
    sql: `SELECT * FROM customers WHERE lower(email) = 'angela.hawkins42@example.com'`,
  },
  { name: 'example 5: pending, an Index Scan of 1,498 rows', setup: 'CREATE INDEX ON orders (status)', sql: `SELECT * FROM orders WHERE status = 'pending'` },
  { name: 'example 5: delivered, a Seq Scan returning 45,000 rows', sql: `SELECT * FROM orders WHERE status = 'delivered'` },
  { name: 'example 3: an index on product_id, a bitmap scan', setup: 'CREATE INDEX ON order_items (product_id)', sql: 'SELECT * FROM order_items WHERE product_id = 42' },
  {
    name: 'example 13: a Nested Loop, 38 loops of an Index Scan',
    sql: `SELECT c.first_name, c.last_name, o.id, o.order_date FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.last_name = 'Hawkins'`,
  },
]

/** Bigger plans than the examples', of other shapes. */
const OTHER_SHAPES: Example[] = [
  { name: 'a Sort of 944 rows from a bitmap scan', sql: 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300 ORDER BY total' },
  { name: 'a top-N heapsort over all 50,000 orders', sql: 'SELECT * FROM orders ORDER BY total DESC LIMIT 10' },
  { name: 'all 200,582 rows of order_items', sql: 'SELECT * FROM order_items' },
  {
    name: 'a Nested Loop over 60 customers, an Index Scan of orders for each',
    sql: 'SELECT c.id, o.id FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.id BETWEEN 1 AND 60',
    off: ['enable_hashjoin', 'enable_mergejoin', 'enable_bitmapscan'],
  },
]

/** Runs a case as the app does and returns its trace, failing if it doesn't replay and validate. */
async function traceOf({ sql, setup, off = [] }: Example): Promise<Trace> {
  if (setup !== undefined) await db.exec(setup)
  await db.exec(off.map((setting) => `SET ${setting} = off;`).join(' '))
  try {
    const [result] = await runStatementAt(db, sql, 0, { emptyCache: true })
    if (result.status !== 'rows' || result.replay?.status !== 'replayed') throw new Error(`${sql}: not replayed`)
    expect(result.replay.validation.checks.filter((check) => !check.ok)).toEqual([])
    return result.replay.trace
  } finally {
    await db.exec(off.map((setting) => `RESET ${setting};`).join(' '))
  }
}

/** The checks every condensed trace passes: every event once, in order, within the budget, the trace untouched. */
function expectCondensed(trace: Trace): Step[] {
  const before = JSON.stringify(trace.events)
  const steps = condense(trace)
  expect(JSON.stringify(trace.events)).toBe(before)

  expect(steps.length / DEFAULT_SPEED).toBeLessThanOrEqual(MAX_SECONDS)
  expect(steps.length).toBeLessThanOrEqual(STEP_BUDGET)
  let next = 0
  for (const step of steps) {
    expect(step.start).toBe(next)
    next = step.end
  }
  expect(next).toBe(trace.events.length)

  // The stretches' counts add up to the trace's own.
  const whole = summarize(trace, 0, trace.events.length)
  let reads = 0
  let hits = 0
  let resultRows = 0
  for (const step of steps) {
    const part = summarize(trace, step.start, step.end)
    reads += part.reads
    hits += part.hits
    resultRows += part.resultRows
  }
  expect({ reads, hits, resultRows }).toEqual({ reads: whole.reads, hits: whole.hits, resultRows: whole.resultRows })
  // A trace that fits as it is isn't condensed; a longer one is.
  expect(steps.some(isStretch)).toBe(trace.events.length > STEP_BUDGET)
  return steps
}

describe(`every example plays in at most ${MAX_SECONDS} s at ${DEFAULT_SPEED} steps/s`, () => {
  for (const example of EXAMPLES) {
    it(example.name, async () => {
      expectCondensed(await traceOf(example))
    })
  }
})

describe('bigger plans of other shapes fit the budget too', () => {
  for (const shape of OTHER_SHAPES) {
    it(shape.name, async () => {
      expectCondensed(await traceOf(shape))
    }, 60_000)
  }
})

describe('a Nested Loop', () => {
  /** Checks each loop of the inner side starts with a step of its own, never inside a stretch; returns how many loops. */
  function expectLoopsOnTheirOwn(trace: Trace): number {
    const steps = expectCondensed(trace)
    const loops = trace.events.flatMap((event, i) => (event.type === 'join.loop' ? [i] : []))
    for (const at of loops) expect(steps).toContainEqual({ start: at, end: at + 1 })
    return loops.length
  }

  it('example 13: each of its 38 loops starts with a step of its own', async () => {
    expect(expectLoopsOnTheirOwn(await traceOf(EXAMPLES.find((example) => example.name.startsWith('example 13')) as Example))).toBe(38)
  })

  it('a longer one, with stretches inside its loops: each loop still starts with a step of its own', async () => {
    const join = OTHER_SHAPES.find((shape) => shape.name.startsWith('a Nested Loop')) as Example
    expect(expectLoopsOnTheirOwn(await traceOf(join))).toBe(60)
  }, 60_000)
})
