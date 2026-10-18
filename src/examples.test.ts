import type { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { runAutovacuum } from './db/autovacuum'
import { createDatabase } from './db/createDatabase'
import type { PlanNode } from './db/plan'
import { runStatementAt, type StatementResult } from './db/runner'
import { seedDatabase } from './db/seed'
import { splitStatements } from './db/statements'
import { EXAMPLES, exampleEditorText, type Example, type ExpectedPlan } from './examples'
import type { Trace } from './replay/trace'

/*
 * Every example, run the way a visitor runs it: its editor text, one
 * statement at a time, with the autovacuum simulator after each, as the app
 * does. Each query must get the plan its example describes and replay with
 * "✓ Replay matches Postgres".
 */

async function freshDatabase() {
  const db = await createDatabase()
  await seedDatabase(db)
  return db
}

/** The headings of a plan's nodes, depth first. */
function titles(node: PlanNode): string[] {
  return [node.title, ...node.children.flatMap(titles)]
}

/** The depth of each of a plan's nodes, depth first, 0 for the top. */
function depths(node: PlanNode, depth = 0): number[] {
  return [depth, ...node.children.flatMap((child) => depths(child, depth + 1))]
}

/** The heap pages a query went through (read or found in shared buffers), not counting visibility map pages. */
function heapPages(trace: Trace): number {
  const tables = new Set(trace.relations.filter((relation) => relation.kind === 'table').map((relation) => relation.id))
  const pages = new Set<string>()
  for (const event of trace.events) {
    if ((event.type === 'buffer.hit' || event.type === 'buffer.read') && event.page.fork === undefined && tables.has(event.page.relation)) {
      pages.add(`${event.page.relation}:${event.page.block}`)
    }
  }
  return pages.size
}

/** The Heap Fetches of every Index Only Scan in a plan. */
function heapFetches(node: PlanNode): number[] {
  return [...(node.heapFetches === null ? [] : [node.heapFetches]), ...node.children.flatMap(heapFetches)]
}

/**
 * Runs an example's statements in order from its editor text, as Run does
 * with the cursor on each, and checks every query against its expectation.
 * `again` is whether the example has run on this database before.
 */
async function runExample(db: PGlite, example: Example, again: boolean) {
  const { text } = exampleEditorText(example)
  const statements = splitStatements(text)
  expect(statements.map((statement) => withoutComments(statement.text))).toEqual(
    example.steps.map((step) => step.sql),
  )
  for (const [index, statement] of statements.entries()) {
    const step = example.steps[index]
    const [result] = await runStatementAt(db, text, statement.to - 1, { emptyCache: true })
    expectNoError(result, step.sql)
    if (step.expect) checkQuery(result, step.sql, step.expect, again)
    await runAutovacuum(db)
  }
}

/** A statement's text without the comment lines above it. */
function withoutComments(text: string) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('--'))
    .join('\n')
}

function expectNoError(result: StatementResult, sql: string) {
  expect(result.status, `${sql}: ${JSON.stringify(result).slice(0, 300)}`).not.toBe('error')
}

function checkQuery(result: StatementResult, sql: string, expected: ExpectedPlan, again: boolean) {
  if (result.status !== 'rows' || result.plan === null) throw new Error(`${sql}: no plan`)
  expect(titles(result.plan.root), sql).toEqual(expected.plan)
  expect(depths(result.plan.root), sql).toEqual(expected.depths ?? expected.plan.map((_, i) => i))
  expect(result.totalRows, sql).toBe(expected.rows)

  const replay = result.replay
  expect(replay?.status, `${sql}: ${JSON.stringify(replay).slice(0, 300)}`).toBe('replayed')
  if (replay?.status !== 'replayed') return
  // What the plan pane shows as "✓ Replay matches Postgres".
  expect(replay.validation.checks.filter((check) => !check.ok), sql).toEqual([])
  expect(replay.validation.ok, sql).toBe(true)

  if (expected.heapPages !== undefined) expect(heapPages(replay.trace), `${sql}: heap pages`).toBe(expected.heapPages)
  if (expected.heapFetches !== undefined) {
    const fetches = again ? expected.heapFetches.again : expected.heapFetches.first
    expect(heapFetches(result.plan.root), `${sql}: heap fetches`).toEqual([fetches])
  }
}

describe('each example on a fresh database', () => {
  for (const example of EXAMPLES) {
    it(`example ${example.id}: ${example.title}`, async () => {
      const db = await freshDatabase()
      try {
        await runExample(db, example, false)
      } finally {
        await db.close()
      }
    }, 120_000)
  }
})

describe('the examples in any order, and again', () => {
  it('runs them all in order, then in reverse, then in order again, with the same plans', async () => {
    const db = await freshDatabase()
    try {
      for (const example of EXAMPLES) await runExample(db, example, false)
      for (const example of [...EXAMPLES].reverse()) await runExample(db, example, true)
      for (const example of EXAMPLES) await runExample(db, example, true)
    } finally {
      await db.close()
    }
  }, 300_000)
})

/** Plan node types the descriptions talk about, longest first so "Index Scan" doesn't match inside "Bitmap Index Scan". */
const NODE_TYPES = [
  'Nested Loop',
  'Index Scan Backward',
  'Bitmap Index Scan',
  'Bitmap Heap Scan',
  'Index Only Scan',
  'Index Scan',
  'Seq Scan',
  'Sort',
  'Limit',
]

/** The node types a text names, e.g. "a Seq Scan, then a Bitmap Heap Scan" → ["Seq Scan", "Bitmap Heap Scan"]. */
function nodeTypesNamed(text: string): Set<string> {
  const named = new Set<string>()
  let rest = text
  for (const type of NODE_TYPES) {
    if (rest.includes(type)) named.add(type)
    rest = rest.replaceAll(type, '')
  }
  return named
}

describe('what the examples say', () => {
  it('numbers them 1 to 13, as docs/DATA.md does', () => {
    expect(EXAMPLES.map((example) => example.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  it('names only plan nodes Postgres actually uses for them', () => {
    for (const example of EXAMPLES) {
      const used = new Set(example.steps.flatMap((step) => step.expect?.plan ?? []).flatMap((title) => [...nodeTypesNamed(title)]))
      const prose = [example.description, ...example.steps.map((step) => step.note)].join(' ')
      for (const type of nodeTypesNamed(prose)) expect(used, `example ${example.id} mentions ${type}`).toContain(type)
    }
  })

  it('writes each step’s expected plan into the editor text', () => {
    const { text, cursor } = exampleEditorText(EXAMPLES[2])
    expect(text).toContain(
      [
        '-- Expected plan (189 rows, 177 heap pages):',
        '--   Bitmap Heap Scan on order_items',
        '--   ->  Bitmap Index Scan on order_items_product_id_idx',
        'SELECT * FROM order_items WHERE product_id = 42;',
      ].join('\n'),
    )
    // The cursor starts on the first statement, so Run runs it.
    expect(text.slice(cursor)).toMatch(/^DROP INDEX IF EXISTS order_items_product_id_idx;/)
  })

  it('indents a join’s inner side under the join, as EXPLAIN does', () => {
    const { text } = exampleEditorText(EXAMPLES.find((example) => example.id === 13) as Example)
    expect(text).toContain(
      [
        '--   Nested Loop',
        '--   ->  Bitmap Heap Scan on customers c',
        '--         ->  Bitmap Index Scan on customers_last_name_first_name_idx',
        '--   ->  Index Scan using orders_customer_id_order_date_idx on orders o',
      ].join('\n'),
    )
  })
})
