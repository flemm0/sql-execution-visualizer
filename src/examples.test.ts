import type { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { createDatabase } from './db/createDatabase'
import type { PlanNode } from './db/plan'
import { runStatementAt, type RowsResult, type StatementResult } from './db/runner'
import { seedDatabase } from './db/seed'
import { splitStatements, statementAt } from './db/statements'
import { EXAMPLES, exampleText, type Example, type ExpectedPlan } from './examples'
import type { Trace } from './replay/trace'

/*
 * The Examples menu's examples, run the way a visitor runs them: the editor
 * text the menu loads, one statement at a time with the cursor in it, the
 * cache emptied first (the app's default). Each query must replay and match
 * Postgres, and its plan must be what the example says it is.
 */

async function freshDatabase() {
  const db = await createDatabase()
  await seedDatabase(db)
  return db
}

/** Runs an example's statements in turn, as Cmd/Ctrl+Enter would with the cursor in each, and returns their results. */
async function runExample(db: PGlite, example: Example): Promise<StatementResult[]> {
  const { text } = exampleText(example)
  const results: StatementResult[] = []
  for (const statement of splitStatements(text)) {
    const [result] = await runStatementAt(db, text, statement.from, { emptyCache: true })
    results.push(result)
  }
  return results
}

/**
 * Runs an example and checks it: every statement succeeds, every query
 * replays with "✓ Replay matches Postgres", and does what the example says.
 * `again`: it ran on this database before, so the numbers that change on a
 * second run (ExpectedPlan.again) apply.
 */
async function runAndCheck(db: PGlite, example: Example, again: boolean) {
  const results = await runExample(db, example)
  expect(results).toHaveLength(example.steps.length)
  example.steps.forEach((step, index) => {
    const result = results[index]
    const where = `example ${example.number}, step ${index + 1} (${step.sql})${again ? ', run again' : ''}`
    expect(result.status, `${where}: ${JSON.stringify(result).slice(0, 300)}`).toBe(step.plan ? 'rows' : 'done')
    if (!step.plan) return
    const query = result as RowsResult
    expect(query.replay?.status, `${where}: ${JSON.stringify(query.replay).slice(0, 300)}`).toBe('replayed')
    if (query.replay?.status !== 'replayed') return
    const failed = query.replay.validation.checks.filter((check) => !check.ok)
    expect(failed, where).toEqual([])
    expect(query.replay.validation.ok, where).toBe(true)

    const { again: changes, ...first } = step.plan
    const expected: Omit<ExpectedPlan, 'again'> = again ? { ...first, ...changes } : first
    expect(observed(query, query.replay.trace, expected), where).toEqual(expected)
  })
}

/** What a query did, in the terms of the fields `expected` has. */
function observed(result: RowsResult, trace: Trace, expected: Omit<ExpectedPlan, 'again'>) {
  const root = result.plan as { root: PlanNode }
  const nodes = allNodes(root.root)
  const actual: Omit<ExpectedPlan, 'again'> = {
    nodes: nodes.map((node) => node.title),
    rows: result.totalRows,
    ...pagesRead(trace),
  }
  if (expected.estimatedRows !== undefined) actual.estimatedRows = root.root.estimatedRows
  if (expected.rowsRemovedByFilter !== undefined) {
    actual.rowsRemovedByFilter = nodes.find((node) => node.rowsRemovedByFilter !== null)?.rowsRemovedByFilter ?? undefined
  }
  if (expected.heapFetches !== undefined) {
    actual.heapFetches = nodes.find((node) => node.heapFetches !== null)?.heapFetches ?? undefined
  }
  if (expected.sortMethod !== undefined) {
    actual.sortMethod = nodes.find((node) => node.sortMethod !== null)?.sortMethod ?? undefined
  }
  return actual
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function allNodes(node: PlanNode): PlanNode[] {
  return [node, ...node.children.flatMap(allNodes)]
}

/**
 * The heap and index pages a query read, each counted once: the pages the
 * trace asks shared buffers for, leaving out the visibility map's and pages
 * read ahead that the scan never reached.
 */
function pagesRead(trace: Trace) {
  const kinds = new Map(trace.relations.map((relation) => [relation.id, relation.kind]))
  const heap = new Set<string>()
  const index = new Set<string>()
  for (const event of trace.events) {
    if (event.type !== 'buffer.hit' && event.type !== 'buffer.read') continue
    if (event.ahead || event.page.fork !== undefined) continue
    const page = `${event.page.relation}/${event.page.block}`
    if (kinds.get(event.page.relation) === 'table') heap.add(page)
    else index.add(page)
  }
  return { heapPages: heap.size, indexPages: index.size }
}

describe('the examples', () => {
  it('are numbered 1 to 12, in order', () => {
    expect(EXAMPLES.map((example) => example.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('say only numbers their plans check, or that are in their SQL', () => {
    for (const example of EXAMPLES) {
      const checked = new Set<number>()
      for (const step of example.steps) {
        for (const value of [...Object.values(step.plan ?? {}), ...Object.values(step.plan?.again ?? {})]) {
          if (typeof value === 'number') checked.add(value)
        }
        for (const number of step.sql.match(/\d+/g) ?? []) checked.add(Number(number))
      }
      const prose = [example.description, ...example.steps.map((step) => step.note)]
        .join(' ')
        // "example 2" names another example; it isn't a number about this one.
        .replace(/example \d+/gi, '')
      const quoted = (prose.match(/\d[\d,]*/g) ?? []).map((number) => Number(number.replace(/,/g, '')))
      const unchecked = quoted.filter((number) => !checked.has(number))
      expect(unchecked, `example ${example.number}`).toEqual([])
    }
  })

  it('load as comments and statements, with the cursor on the first statement', () => {
    for (const example of EXAMPLES) {
      const { text, cursor } = exampleText(example)
      const statements = splitStatements(text)
      // Each statement is a step's SQL, after the comments above it.
      expect(statements).toHaveLength(example.steps.length)
      statements.forEach((statement, index) => expect(statement.text.endsWith(example.steps[index].sql)).toBe(true))
      // The cursor is at the start of the first statement's SQL, so Cmd/Ctrl+Enter runs it.
      expect(text.slice(cursor)).toMatch(new RegExp(`^${escape(example.steps[0].sql)};`))
      expect(statementAt(statements, cursor)).toBe(statements[0])
      expect(text).toMatch(new RegExp(`^-- Example ${example.number}: `))
      // Comments are wrapped to fit an editor of the default width.
      for (const line of text.split('\n').filter((line) => line.startsWith('--'))) {
        expect(line.length, line).toBeLessThanOrEqual(70)
      }
    }
  })
})

describe('each example on a fresh database', () => {
  for (const example of EXAMPLES) {
    it(`example ${example.number}: ${example.title}, then the same again`, async () => {
      const db = await freshDatabase()
      try {
        await runAndCheck(db, example, false)
        // Run twice, it still works: a setup like CREATE INDEX doesn't fail the second time.
        await runAndCheck(db, example, true)
      } finally {
        await db.close()
      }
    }, 120_000)
  }
})

describe('the examples in any order', () => {
  it('all 12 in order, then in reverse, on one database', async () => {
    const db = await freshDatabase()
    try {
      const ran = new Set<number>()
      for (const example of [...EXAMPLES, ...[...EXAMPLES].reverse()]) {
        await runAndCheck(db, example, ran.has(example.number))
        ran.add(example.number)
      }
    } finally {
      await db.close()
    }
  }, 300_000)
})
