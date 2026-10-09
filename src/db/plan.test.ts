import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import { parsePlan, type PlanNode } from './plan'
import { seedDatabase } from './seed'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
}, 120_000)
afterAll(() => db.close())

async function planFor(sql: string) {
  const result = await db.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${sql}`)
  return parsePlan(result.rows[0]['QUERY PLAN'])
}

/** Every node's title, depth first, indented two spaces per level. */
function outline(node: PlanNode, depth = 0): string[] {
  return [`${'  '.repeat(depth)}${node.title}`, ...node.children.flatMap((child) => outline(child, depth + 1))]
}

/** Postgres's own text EXPLAIN headings, for comparison. */
async function textHeadings(sql: string) {
  const result = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`)
  return result.rows
    .map((row) => row['QUERY PLAN'])
    .filter((line) => /^\s*(->\s+)?[A-Z]/.test(line) && !/^\s*[A-Z][\w ]*:/.test(line.replace(/^\s*->\s+/, '')))
    .map((line) => line.replace(/^\s*(->\s+)?/, ''))
}

describe('plan node titles match Postgres’s text EXPLAIN', () => {
  const queries = [
    'SELECT * FROM orders WHERE id = 4242',
    'SELECT * FROM orders o WHERE o.id BETWEEN 10 AND 20',
    'SELECT * FROM orders ORDER BY id DESC LIMIT 3',
    'SELECT status, count(*) FROM orders GROUP BY status',
    'SELECT count(*) FROM categories',
    'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300',
    'SELECT * FROM categories c LEFT JOIN products p ON p.category_id = c.id',
  ]
  for (const sql of queries) {
    it(sql, async () => {
      const plan = await planFor(sql)
      const titles = outline(plan.root).map((line) => line.trim())
      expect(titles).toEqual(await textHeadings(sql))
    })
  }
})

describe('parsePlan', () => {
  it('keeps estimated and actual rows, loops, buffers, timings and conditions', async () => {
    const plan = await planFor(`SELECT * FROM order_items WHERE product_id = 42`)
    const scan = plan.root
    expect(scan.nodeType).toBe('Seq Scan')
    expect(scan.loops).toBe(1)
    expect(scan.estimatedRows).toBeGreaterThan(0)
    const count = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM order_items WHERE product_id = 42')
    expect(scan.actualRows).toBe(count.rows[0].count)
    // A Seq Scan touches every heap page once.
    const pages = await db.query<{ pages: number }>(`SELECT relpages AS pages FROM pg_class WHERE relname = 'order_items'`)
    expect(scan.sharedHit + scan.sharedRead).toBe(pages.rows[0].pages)
    expect(scan.details).toContainEqual({ label: 'Filter', value: '(order_items.product_id = 42)' })
    expect(scan.details.find((detail) => detail.label === 'Rows Removed by Filter')).toBeDefined()
    expect(plan.planningMs).toBeGreaterThanOrEqual(0)
    expect(plan.executionMs).toBeGreaterThan(0)
  })
})

describe('details', () => {
  it('leave out zero counters, as text EXPLAIN does', async () => {
    const plan = await planFor('SELECT * FROM orders WHERE id = 4242')
    expect(plan.root.details.map((detail) => detail.label)).toEqual(['Index Cond', 'Index Searches'])
  })
})
