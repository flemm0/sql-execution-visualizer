import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt } from '../db/runner'
import { seedDatabase } from '../db/seed'
import type { Trace, TraceEvent } from './trace'
import { validate, type ValidationInput } from './validate'

let db: PGlite
/** A replay of example 11 that passes every check, to tamper with. */
let good: ValidationInput

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
  const [result] = await runStatementAt(db, 'SELECT * FROM categories WHERE id > 9', 0, { emptyCache: true })
  if (result.status !== 'rows' || result.plan === null || result.replay?.status !== 'replayed') throw new Error('no replay')
  good = {
    plan: result.plan,
    trace: result.replay.trace,
    resultRows: result.rows,
    totalRows: result.totalRows,
    replayedRows: result.rows.map((row) => [...row]),
    notes: [],
  }
}, 120_000)
afterAll(() => db.close())

/** The labels of the checks that fail when the trace's events are changed by `change`. */
function failedWith(change: (events: TraceEvent[]) => TraceEvent[], input: Partial<ValidationInput> = {}) {
  const trace: Trace = { ...good.trace, events: change([...good.trace.events]) }
  const validation = validate({ ...good, trace, ...input })
  expect(validation.ok).toBe(false)
  return validation.checks.filter((check) => !check.ok).map((check) => check.label)
}

describe('the validator', () => {
  it('passes a faithful replay', () => {
    expect(validate(good)).toMatchObject({ ok: true, notes: [] })
  })

  it('catches a hit counted as a read', () => {
    const swapped = (events: TraceEvent[]) =>
      events.map((event): TraceEvent => (event.type === 'buffer.read' ? { ...event, type: 'buffer.hit' } : event))
    expect(failedWith(swapped)).toEqual(['Seq Scan on categories: buffer hits', 'Seq Scan on categories: buffer reads'])
  })

  it('catches a missing row, which also changes rows removed by the filter', () => {
    const dropLastRow = (events: TraceEvent[]) => {
      const last = events.findLastIndex((event) => event.type === 'row.emit')
      return events
        .filter((_, i) => i !== last)
        .map((event) => (event.type === 'heap.page' ? { ...event, matchedRows: event.matchedRows - 1 } : event))
    }
    expect(failedWith(dropLastRow)).toEqual([
      'Seq Scan on categories: rows',
      'Seq Scan on categories: rows removed by filter',
      'Result: rows',
    ])
  })

  it('catches rows with other values, or in another order', () => {
    const [first, ...rest] = good.replayedRows ?? []
    expect(failedWith((events) => events, { replayedRows: [...rest, first] })).toEqual([
      'Result: rows with the same values, in the same order',
    ])
    expect(failedWith((events) => events, { replayedRows: [['99', 'Nope', null], ...rest] })).toEqual([
      'Result: rows with the same values, in the same order',
    ])
  })

  it('says so when the values couldn’t be compared', () => {
    const validation = validate({ ...good, replayedRows: null })
    expect(validation.ok).toBe(true)
    expect(validation.notes).toEqual(['The values of the rows sent to the result weren’t compared with the real result.'])
  })
})
