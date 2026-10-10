import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import { parsePlan, parsePlanning, tablesInPlan, type PlanNode } from './plan'
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

describe('tablesInPlan', () => {
  async function tablesOf(sql: string) {
    const result = await db.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`)
    return tablesInPlan(result.rows[0]['QUERY PLAN'])
  }

  it('lists each table a plan reads once, with its schema, from every level of the tree', async () => {
    expect(await tablesOf('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 4242')).toEqual([
      { schema: 'public', name: 'orders' },
      { schema: 'public', name: 'customers' },
    ])
    // A self-join, and a subquery the planner keeps as a SubPlan.
    expect(
      await tablesOf(`SELECT * FROM orders a JOIN orders b ON b.id = a.id + 1
                      WHERE a.total > (SELECT avg(price) FROM products WHERE category_id = a.id)`),
    ).toEqual([
      { schema: 'public', name: 'orders' },
      { schema: 'public', name: 'products' },
    ])
  })

  it('sees through a view to its tables, and lists none for a query without one', async () => {
    await db.exec('CREATE VIEW cheap_products AS SELECT * FROM products WHERE price < 10')
    expect(await tablesOf('SELECT * FROM cheap_products')).toEqual([{ schema: 'public', name: 'products' }])
    await db.exec('DROP VIEW cheap_products')
    expect(await tablesOf('SELECT 1')).toEqual([])
  })
})

describe('parsePlanning', () => {
  it('reads planning’s time and buffer counts, which a plan without ANALYZE reports too', async () => {
    await db.query(`SELECT pg_buffercache_evict_relation('orders_customer_id_order_date_idx')`)
    // 1 is the lowest customer_id, so the planner reads index pages to find the real minimum.
    const result = await db.query<{ 'QUERY PLAN': unknown }>(
      'EXPLAIN (BUFFERS, SUMMARY, FORMAT JSON) SELECT * FROM orders WHERE customer_id BETWEEN 1 AND 100',
    )
    const planning = parsePlanning(result.rows[0]['QUERY PLAN'])
    expect(planning.planningMs).toBeGreaterThan(0)
    expect(planning.planningRead).toBeGreaterThan(0)
  })
})
