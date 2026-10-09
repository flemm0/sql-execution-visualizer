import { describe, expect, it } from 'vitest'
import type { AutovacuumAction } from '../db/autovacuum'
import { actionReasons, actionTitle } from './describe'

function action(overrides: Partial<AutovacuumAction> = {}): AutovacuumAction {
  return {
    schema: 'public',
    table: 'order_items',
    vacuumed: true,
    analyzed: true,
    assessment: {
      enabled: true,
      deadRows: { count: 48_167, threshold: 40_166 },
      insertedRows: { count: 0, threshold: 41_116 },
      changedRows: { count: 48_167, threshold: 20_108 },
      vacuum: true,
      analyze: true,
    },
    ...overrides,
  }
}

describe('autovacuum notices', () => {
  it('say what was done, naming tables outside public with their schema', () => {
    expect(actionTitle(action())).toBe('autovacuum: vacuumed and analyzed order_items')
    expect(actionTitle(action({ analyzed: false }))).toBe('autovacuum: vacuumed order_items')
    expect(actionTitle(action({ schema: 'sales', vacuumed: false }))).toBe('autovacuum: analyzed sales.order_items')
  })

  it('list only the counters that crossed their thresholds', () => {
    expect(actionReasons(action())).toEqual([
      '48,167 dead rows (threshold 40,166)',
      '48,167 rows changed since the last analyze (threshold 20,108)',
    ])
    const inserts = action()
    inserts.assessment = { ...inserts.assessment, insertedRows: { count: 1, threshold: 0 }, deadRows: { count: 1, threshold: 0 } }
    expect(actionReasons(inserts).slice(0, 2)).toEqual([
      '1 dead row (threshold 0)',
      '1 row inserted since the last vacuum (threshold 0)',
    ])
  })
})
