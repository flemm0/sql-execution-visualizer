import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { seedDatabase } from '../db/seed'
import { parseLimits, readLimits } from './limits'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
}, 120_000)
afterAll(() => db.close())

/** Limit nodes as Postgres 18 writes them out, broken into lines at spaces, their other fields cut short. */
const DUMP = `{PLANNEDSTMT :commandType 1 :planTree {LIMIT
:plan.disabled_nodes 0 :plan.plan_node_id 0
:plan.targetlist ({TARGETENTRY :expr {VAR :varno -2} :resno 1 :resname \\{odd\\}\\ name :resjunk false})
:plan.qual <> :plan.lefttree {LIMIT :plan.plan_node_id 1 :plan.lefttree {SEQSCAN :scan.plan.plan_node_id 2}
:limitOffset <> :limitCount {PARAM :paramkind 0 :paramid 1} :limitOption 0} :limitOffset {CONST :consttype 20
:consttypmod -1 :constcollid 0 :constlen 8 :constbyval false :constisnull false :location -1
:constvalue 8 [ 2 0 0 0 0 0 0 0 ]} :limitCount {CONST :consttype 20 :consttypmod -1 :constcollid 0 :constlen 8
:constbyval false :constisnull false :location 47 :constvalue 8 [ 0 94 -48 -78 0 0 0 0 ]} :limitOption 0
:uniqNumCols 0}}`

describe('reading a Limit node from Postgres’s plan dump', () => {
  it('reads each Limit of the plan tree, outermost first: constants, and values only known when the query runs', () => {
    expect(parseLimits(DUMP)).toEqual([
      { status: 'constant', settings: { offset: 2, count: 3_000_000_000 } },
      { status: 'notConstant' },
    ])
  })
})

describe('reading a query’s Limit nodes from Postgres', () => {
  it('reads LIMIT and OFFSET, worked out by the planner', async () => {
    const read = (sql: string) => readLimits(db, sql)
    const constant = (offset: number, count: number | null) => ({ status: 'constant', settings: { offset, count } })
    expect(await read('SELECT * FROM orders ORDER BY id OFFSET 2 LIMIT 3')).toEqual([constant(2, 3)])
    expect(await read('SELECT * FROM orders LIMIT 2 + 1')).toEqual([constant(0, 3)])
    expect(await read('SELECT * FROM orders OFFSET 5')).toEqual([constant(5, null)])
    expect(await read('SELECT * FROM orders ORDER BY total FETCH FIRST 2 ROWS WITH TIES')).toEqual([{ status: 'withTies' }])
    expect(await read('SELECT * FROM orders LIMIT (SELECT 3)')).toEqual([{ status: 'notConstant' }])
    expect(await read('SELECT * FROM orders')).toEqual([])
    // A Limit in a subquery, under the outer one: outermost first.
    expect(await read('SELECT * FROM (SELECT * FROM orders ORDER BY id LIMIT 20) s LIMIT 5')).toEqual([constant(0, 5), constant(0, 20)])
  })

  it('leaves the session’s settings as they were', async () => {
    await db.exec(`SET client_min_messages = warning`)
    await readLimits(db, 'SELECT * FROM orders LIMIT 3')
    const settings = await db.query<{ level: string; print: string }>(
      `SELECT current_setting('client_min_messages') AS level, current_setting('debug_print_plan') AS print`,
    )
    expect(settings.rows[0]).toEqual({ level: 'warning', print: 'off' })
    await db.exec(`RESET client_min_messages`)
  })
})
