import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { runStatementAt, type StatementResult } from '../db/runner'
import { seedDatabase } from '../db/seed'
import type { Trace, TraceEvent } from './trace'
import { validate, type ValidationInput } from './validate'

let db: PGlite
/** A replay of example 11 that passes every check, to tamper with. */
let good: ValidationInput
/** The same for an Index Scan with a Filter. */
let goodIndexScan: ValidationInput
/** The same for an Index Only Scan with a Filter. */
let goodIndexOnlyScan: ValidationInput
/** The same for a Bitmap Heap Scan over a Bitmap Index Scan. */
let goodBitmapScan: ValidationInput

beforeAll(async () => {
  db = await createDatabase()
  await seedDatabase(db)
  const [result] = await runStatementAt(db, 'SELECT * FROM categories WHERE id > 9', 0, { emptyCache: true })
  good = asInput(result)
  const [indexScan] = await runStatementAt(db, `SELECT * FROM orders WHERE id BETWEEN 100 AND 200 AND total > 100`, 0, {
    emptyCache: true,
  })
  goodIndexScan = asInput(indexScan)
  const [indexOnlyScan] = await runStatementAt(
    db,
    `SELECT customer_id, order_date FROM orders WHERE customer_id BETWEEN 40 AND 45 AND extract(dow FROM order_date) <> 1`,
    0,
    { emptyCache: true },
  )
  goodIndexOnlyScan = asInput(indexOnlyScan)
  const [bitmapScan] = await runStatementAt(db, 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 120', 0, {
    emptyCache: true,
  })
  goodBitmapScan = asInput(bitmapScan)
}, 120_000)
afterAll(() => db.close())

/** A run's replay, as the validator's input, with the values it read the same as the result's. */
function asInput(result: StatementResult): ValidationInput {
  if (result.status !== 'rows' || result.plan === null || result.replay?.status !== 'replayed') throw new Error('no replay')
  return {
    plan: result.plan,
    trace: result.replay.trace,
    resultRows: result.rows,
    totalRows: result.totalRows,
    replayedRows: result.rows.map((row) => [...row]),
    notes: [],
  }
}

/** The labels of the checks that fail when the trace's events are changed by `change`. */
function failedWith(
  change: (events: TraceEvent[]) => TraceEvent[],
  input: Partial<ValidationInput> = {},
  base: ValidationInput = good,
) {
  const trace: Trace = { ...base.trace, events: change([...base.trace.events]) }
  const validation = validate({ ...base, trace, ...input })
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

  it('passes a faithful Index Scan replay', () => {
    expect(validate(goodIndexScan)).toMatchObject({ ok: true, notes: [] })
  })

  it('catches a missing search down the index', () => {
    const dropSearch = (events: TraceEvent[]) => events.filter((event) => event.type !== 'index.search')
    expect(failedWith(dropSearch, {}, goodIndexScan)).toEqual([
      'Index Scan using orders_pkey on orders: index searches',
    ])
  })

  it('counts a fetched row that fails the Filter as removed by it', () => {
    // The first row that passed is said to fail, and isn't emitted.
    const failFirst = (events: TraceEvent[]) => {
      const first = events.findIndex((event) => event.type === 'heap.tuple' && event.matched)
      return events
        .map((event, i) => (i === first ? { ...event, matched: false } : event))
        .filter((event, i) => !(i === first + 1 && event.type === 'row.emit'))
    }
    expect(failedWith(failFirst, {}, goodIndexScan)).toEqual([
      'Index Scan using orders_pkey on orders: rows',
      'Index Scan using orders_pkey on orders: rows removed by filter',
      'Result: rows',
    ])
  })

  it('compares an Index Only Scan’s heap fetches, and counts entries rejected without a fetch as removed', () => {
    expect(validate(goodIndexOnlyScan)).toMatchObject({ ok: true, notes: [] })
    // A row on an all-visible page said to need a fetch.
    const fetchFirst = (events: TraceEvent[]) =>
      events.flatMap((event): TraceEvent[] =>
        event.type === 'visibility.check' && event === events.find((each) => each.type === 'visibility.check')
          ? [{ ...event, allVisible: false, matched: null }, { type: 'heap.tuple', node: event.node, row: event.row, visible: event.row, matched: true }]
          : [event],
      )
    const title = 'Index Only Scan using orders_customer_id_order_date_idx on orders'
    expect(failedWith(fetchFirst, {}, goodIndexOnlyScan)).toEqual([`${title}: heap fetches`])
    // An entry that passed said to fail the filter: one more row removed, one fewer emitted.
    const failFirst = (events: TraceEvent[]) => {
      const first = events.findIndex((event) => event.type === 'visibility.check' && event.matched === true)
      return events
        .map((event, i) => (i === first ? { ...event, matched: false } : event))
        .filter((event, i) => !(i === first + 1 && event.type === 'row.emit'))
    }
    expect(failedWith(failFirst, {}, goodIndexOnlyScan)).toEqual([
      `${title}: rows`,
      `${title}: rows removed by filter`,
      'Result: rows',
    ])
  })

  it('counts the rows a Bitmap Index Scan marks in its bitmap, and compares the heap pages read with Exact Heap Blocks', () => {
    expect(validate(goodBitmapScan)).toMatchObject({ ok: true, notes: [] })
    const index = 'Bitmap Index Scan on orders_customer_id_order_date_idx'
    // An entry whose row isn't marked in the bitmap: one row fewer for the index scan.
    const unmarkFirst = (events: TraceEvent[]) =>
      events.map((event): TraceEvent => (event === events.find((each) => each.type === 'index.entry') ? { ...event, bitmap: undefined } : event))
    expect(failedWith(unmarkFirst, {}, goodBitmapScan)).toEqual([`${index}: rows`])
    // A heap page read twice: one more hit, and one more page than the bitmap has.
    const readTwice = (events: TraceEvent[]) => {
      const first = events.findIndex((event) => event.type === 'buffer.read' && event.node === 0)
      const again = { ...events[first], type: 'buffer.hit' } as TraceEvent
      return [...events.slice(0, first + 1), again, ...events.slice(first + 1)]
    }
    expect(failedWith(readTwice, {}, goodBitmapScan)).toEqual(['Bitmap Heap Scan on orders: buffer hits'])
    // A heap page the bitmap doesn't mark: one more page, one more read.
    const extraPage = (events: TraceEvent[]) => {
      const first = events.findIndex((event) => event.type === 'buffer.read' && event.node === 0)
      const page = { relation: (events[first] as { page: { relation: number } }).page.relation, block: 588 }
      return [...events.slice(0, first), { type: 'buffer.read', node: 0, page } as TraceEvent, ...events.slice(first)]
    }
    expect(failedWith(extraPage, {}, goodBitmapScan)).toEqual([
      'Bitmap Heap Scan on orders: exact heap blocks',
      'Bitmap Heap Scan on orders: buffer reads',
    ])
  })

  it('says so when the values couldn’t be compared', () => {
    const validation = validate({ ...good, replayedRows: null })
    expect(validation.ok).toBe(true)
    expect(validation.notes).toEqual(['The values of the rows sent to the result weren’t compared with the real result.'])
  })
})
