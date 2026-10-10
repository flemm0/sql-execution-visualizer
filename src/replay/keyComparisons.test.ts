import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import type { IndexColumn } from '../db/inspector'
import { canReadKeys } from './indexKeys'
import { canStep, KeyComparisons } from './keyComparisons'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
})
afterAll(() => db.close())

function column(type: string, collation: string | null = null): IndexColumn {
  return { name: 'c', type, isKey: true, collation, descending: false, nullsFirst: false, defaultOrder: true }
}

describe('KeyComparisons', () => {
  it('knows which types count up in a skip scan, as Postgres lists them (skip support)', async () => {
    const types = ['bool', 'int2', 'int4', 'int8', 'oid', 'date', 'timestamp', 'timestamptz', 'text', 'varchar']
    expect(types.every(canReadKeys)).toBe(true)
    const result = await db.query<{ type: string }>(`
      SELECT t.typname AS type FROM pg_amproc p JOIN pg_type t ON t.oid = p.amproclefttype
      WHERE p.amprocnum = 6 AND p.amprocfamily IN (SELECT oid FROM pg_opfamily WHERE opfmethod = 403)`)
    const supported = new Set(result.rows.map((row) => row.type))
    expect(types.filter(canStep)).toEqual(types.filter((type) => supported.has(type)))
  })

  it('compares values with each other and with conditions’ values of other types, in the column’s collation', async () => {
    const comparisons = new KeyComparisons(db, [column('int4'), column('text', '"C"')], [['5::bigint'], []], [[], []], [true, false])
    await comparisons.prepare([['CAST(4 AS int4)', 'CAST(5 AS int4)'], [`'a'`, `'B'`]])
    expect(await comparisons.compareWithConstant(0, 'CAST(4 AS int4)', '5::bigint')).toBe(-1)
    expect(await comparisons.compareWithConstant(0, 'CAST(5 AS int4)', '5::bigint')).toBe(0)
    // In the C collation, upper case sorts before lower case.
    expect(await comparisons.compare(1, `'a'`, `'B'`)).toBe(1)
    expect(comparisons.text(1, `'B'`)).toBe('B')
  })

  it('finds a value’s place in a list', async () => {
    const list = ['2', '4', '6']
    const comparisons = new KeyComparisons(db, [column('int4')], [[]], [[list]], [false])
    const signs = async (value: string) =>
      Promise.all(list.map((_, position) => comparisons.compareWithElement(0, value, list, position)))
    expect(await signs('4')).toEqual([1, 0, -1])
    expect(await signs('5')).toEqual([1, 1, -1])
    expect(await signs('7')).toEqual([1, 1, 1])
  })

  it('steps to the next value, and past the last there is none; the value stays short however many steps', async () => {
    const comparisons = new KeyComparisons(db, [column('int4')], [[]], [[]], [true])
    let value = 'CAST(1 AS int4)'
    for (let step = 0; step < 40; step++) value = (await comparisons.next(0, value)) as string
    expect(value.length).toBeLessThan(40)
    expect(await comparisons.compare(0, value, 'CAST(41 AS int4)')).toBe(0)
    expect(await comparisons.next(0, 'CAST(2147483647 AS int4)')).toBeNull()
  })
})
