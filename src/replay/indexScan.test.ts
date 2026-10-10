import { describe, expect, it } from 'vitest'
import type { IndexColumn } from '../db/inspector'
import { parseIndexCond } from './indexScan'

function column(name: string | null, type = 'int4', options: Partial<IndexColumn> = {}): IndexColumn {
  return { name, type, isKey: true, collation: null, descending: false, nullsFirst: false, defaultOrder: true, ...options }
}

const orderColumns = [column('customer_id'), column('order_date', 'date')]

describe('parseIndexCond', () => {
  it('reads one condition, or several joined by AND, as Postgres deparses them', () => {
    expect(parseIndexCond('(orders.id = 4242)', 'orders', [column('id')])).toEqual([
      { column: 0, operator: '=', value: '4242' },
    ])
    expect(parseIndexCond('((orders.id >= 1000) AND (orders.id <= 2000))', 'orders', [column('id')])).toEqual([
      { column: 0, operator: '>=', value: '1000' },
      { column: 0, operator: '<=', value: '2000' },
    ])
  })

  it('has no keys for a scan without an Index Cond (a scan of the whole index, for its order)', () => {
    expect(parseIndexCond(null, 'orders', [column('id')])).toEqual([])
  })

  it('sorts keys by column, lower bounds before upper ones, as Postgres checks them', () => {
    const cond = `((o.order_date < '2024-01-01'::date) AND (o.customer_id = 42) AND (o.order_date > '2023-01-01'::date))`
    expect(parseIndexCond(cond, 'o', orderColumns)).toEqual([
      { column: 0, operator: '=', value: '42' },
      { column: 1, operator: '>', value: `'2023-01-01'::date` },
      { column: 1, operator: '<', value: `'2024-01-01'::date` },
    ])
  })

  it('keeps values whole: quotes, parentheses and ANDs inside a string are part of it', () => {
    const cond = `((c.last_name = 'Smith (AND) O''Brien'::text) AND (c.first_name >= 'K'::text))`
    expect(parseIndexCond(cond, 'c', [column('last_name', 'text'), column('first_name', 'text')])).toEqual([
      { column: 0, operator: '=', value: `'Smith (AND) O''Brien'::text` },
      { column: 1, operator: '>=', value: `'K'::text` },
    ])
  })

  it('reads quoted names, and a varchar column compared as text', () => {
    expect(parseIndexCond(`("b b"."Bin No" > 5)`, 'b b', [column('Bin No')])).toEqual([
      { column: 0, operator: '>', value: '5' },
    ])
    expect(parseIndexCond(`((t.code)::text = 'x'::text)`, 't', [column('code', 'varchar')])).toEqual([
      { column: 0, operator: '=', value: `'x'::text` },
    ])
  })

  it('reads a list of values (= ANY), and conditions after a column without one (a skip scan)', () => {
    expect(parseIndexCond(`(t.id = ANY ('{5,1}'::integer[]))`, 't', [column('id')])).toEqual([
      { column: 0, operator: '= ANY', value: `'{5,1}'::integer[]` },
    ])
    const cond = `((t.order_date = ANY (ARRAY['2024-01-01'::date, '2024-02-01'::date])) AND (t.customer_id > 5))`
    expect(parseIndexCond(cond, 't', orderColumns)).toEqual([
      { column: 0, operator: '>', value: '5' },
      { column: 1, operator: '= ANY', value: `ARRAY['2024-01-01'::date, '2024-02-01'::date]` },
    ])
    expect(parseIndexCond(`(t.order_date = '2024-01-01'::date)`, 't', orderColumns)).toEqual([
      { column: 1, operator: '=', value: `'2024-01-01'::date` },
    ])
  })

  it('says what it can’t replay yet', () => {
    const reason = (cond: string, columns = [column('id')]) => {
      try {
        parseIndexCond(cond, 't', columns)
        return 'supported'
      } catch (error) {
        return (error as Error).message
      }
    }
    expect(reason(`(t.id < ANY ('{1,2}'::integer[]))`)).toBe(
      `Animation isn’t available yet for the index condition t.id < ANY ('{1,2}'::integer[]).`,
    )
    expect(reason(`(t.id = ALL ('{1,2}'::integer[]))`)).toContain('index condition')
    expect(reason(`((t.id = ANY ('{1,2}'::integer[])) AND (t.id > 1))`)).toBe(
      'Animation isn’t available yet for several conditions of the same kind on one index column.',
    )
    expect(reason(`((t.id > 5) AND (t.id > 7))`)).toBe(
      'Animation isn’t available yet for several conditions of the same kind on one index column.',
    )
    expect(reason(`(lower(t.email) = 'a'::text)`, [column(null, 'text')])).toBe(
      'Animation isn’t available yet for index conditions on expressions.',
    )
    expect(reason(`(t.id IS NULL)`)).toBe('Animation isn’t available yet for the index condition t.id IS NULL.')
    expect(reason(`(t.id = 1)`, [column('id', 'numeric')])).toBe(
      'Animation isn’t available yet for indexes on numeric columns.',
    )
    expect(reason(`(t.id = 1)`, [column('id', 'int4', { descending: true })])).toBe(
      'Animation isn’t available yet for indexes sorted DESC or NULLS FIRST.',
    )
    expect(reason(`(t.id = 1)`, [column('id', 'text', { defaultOrder: false })])).toContain('operator class')
    // INCLUDE columns aren't keys: their types don't matter.
    expect(reason(`(t.id = 1)`, [column('id'), column('total', 'numeric', { isKey: false })])).toBe('supported')
  })
})
