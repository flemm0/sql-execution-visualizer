import { describe, expect, it } from 'vitest'
import type { Trace, TraceEvent } from '../replay/trace'
import {
  EARLY_EVENTS,
  STEP_BUDGET,
  collapseStretch,
  condense,
  describeStretch,
  eventsDone,
  expandStretch,
  isStretch,
  summarize,
  type Step,
} from './condense'
import type { NodeInfo } from './playback'

const TABLE = 16384

function trace(events: TraceEvent[]): Trace {
  return {
    relations: [{ id: TABLE, name: 'order_items', kind: 'table', pages: 5000 }],
    events,
    indexPages: [],
    sorts: [],
    limits: [],
    heapPages: [],
  }
}

/**
 * A Seq Scan of `pages` pages with `perPage` visible rows each; `matches(page)`
 * says how many of a page's rows pass the filter and go to the result.
 */
function seqScan(pages: number, perPage: number, matches: (page: number) => number): Trace {
  const events: TraceEvent[] = [{ type: 'node.start', node: 0 }]
  let resultIndex = 0
  for (let block = 0; block < pages; block++) {
    const page = { relation: TABLE, block }
    const matched = matches(block)
    events.push({ type: 'buffer.read', node: 0, page })
    events.push({ type: 'heap.page', node: 0, page, visibleRows: perPage, matchedRows: matched })
    for (let offset = 1; offset <= matched; offset++) {
      events.push({ type: 'row.emit', node: 0, row: { relation: TABLE, block, offset }, resultIndex: resultIndex++ })
    }
  }
  events.push({ type: 'node.finish', node: 0 })
  return trace(events)
}

const NODES = new Map<number, NodeInfo>([[0, { title: 'Seq Scan on order_items', hasFilter: true }]])

/** Every event is in exactly one step, in order: steps are consecutive ranges from the first event to the last. */
function expectEveryEventOnce(steps: Step[], events: number) {
  let next = 0
  for (const step of steps) {
    expect(step.start).toBe(next)
    expect(step.end).toBeGreaterThan(step.start)
    next = step.end
  }
  expect(next).toBe(events)
}

/** Counts of each event type, and the result rows, over all events. */
function totals(t: Trace) {
  const all = summarize(t, 0, t.events.length)
  return { reads: all.reads, hits: all.hits, rowsChecked: all.rowsChecked, rowsMatched: all.rowsMatched, resultRows: all.resultRows }
}

describe('condensing a trace into steps', () => {
  it('leaves a trace that fits the budget alone: one step per event', () => {
    const short = seqScan(10, 50, (page) => (page === 3 ? 2 : 0))
    const steps = condense(short)
    expect(steps).toEqual(short.events.map((_, i) => ({ start: i, end: i + 1 })))
  })

  it('keeps every event, in order, and its stretches’ counts add up to the trace’s exactly', () => {
    // Example 2's shape: 1,278 pages, a matching row on every seventh.
    const big = seqScan(1278, 157, (page) => (page % 7 === 0 ? 1 : 0))
    const steps = condense(big)
    expect(steps.length).toBeLessThanOrEqual(STEP_BUDGET)
    expect(steps.some(isStretch)).toBe(true)
    expectEveryEventOnce(steps, big.events.length)

    const added = { reads: 0, hits: 0, rowsChecked: 0, rowsMatched: 0, resultRows: 0 }
    for (const step of steps) {
      const summary = summarize(big, step.start, step.end)
      added.reads += summary.reads
      added.hits += summary.hits
      added.rowsChecked += summary.rowsChecked
      added.rowsMatched += summary.rowsMatched
      added.resultRows += summary.resultRows
    }
    expect(added).toEqual(totals(big))
    expect(added.resultRows).toBe(183)
    expect(added.reads).toBe(1278)
  })

  it('counts a stretch from its own events: pages, rows checked and matched, buffers, result rows', () => {
    const t = seqScan(6, 100, (page) => (page === 4 ? 3 : 0))
    // Pages 1 to 4 and page 4's three rows: events 3 to 13.
    const summary = summarize(t, 3, 14)
    expect(summary.scannedPages).toEqual([1, 2, 3, 4])
    expect(summary.rowsChecked).toBe(400)
    expect(summary.rowsMatched).toBe(3)
    expect(summary.reads).toBe(4)
    expect(summary.resultRows).toBe(3)
    expect([summary.firstResultRow, summary.lastResultRow]).toEqual([0, 2])
    expect(describeStretch(t, NODES, { start: 3, end: 14 })).toBe(
      'Heap pages 1 to 4: 400 rows visible to the query, checked against the filter; 3 pass. Buffers: 4 pages read from disk into shared buffers. 3 rows go to the result: rows 1 to 3.',
    )
  })

  it('plays the first pages event by event, then a page or more at a time', () => {
    const big = seqScan(2000, 157, () => 0)
    const steps = condense(big)
    // node.start, then pages until EARLY_EVENTS events have played one by one.
    const early = steps.slice(0, 1 + EARLY_EVENTS)
    expect(early.every((step) => !isStretch(step))).toBe(true)
    expect(isStretch(steps[1 + EARLY_EVENTS])).toBe(true)
    // The last step is the node finishing, on its own.
    expect(steps.at(-1)).toEqual({ start: big.events.length - 1, end: big.events.length })
  })

  it('flashes each row sent to the result on its own step when they fit the budget', () => {
    const big = seqScan(1278, 157, (page) => (page % 7 === 0 ? 1 : 0))
    const steps = condense(big)
    const emits = big.events.flatMap((event, i) => (event.type === 'row.emit' ? [i] : []))
    for (const at of emits) expect(steps).toContainEqual({ start: at, end: at + 1 })
  })

  it('carries the rows in its stretches when there are too many to flash one by one (example 5’s 45,000)', () => {
    const big = seqScan(589, 85, () => 77)
    const steps = condense(big)
    expect(steps.length).toBeLessThanOrEqual(STEP_BUDGET)
    expectEveryEventOnce(steps, big.events.length)
    // A page and its rows together: "Heap page 37: … 77 pass. … 77 rows go to the result: rows …".
    const stretch = steps.find((step) => isStretch(step) && summarize(big, step.start, step.end).scannedPages.length === 1)
    expect(stretch).toBeDefined()
    expect(summarize(big, stretch!.start, stretch!.end).resultRows).toBe(77)
  })

  it('holds a big trace within the budget too (all 200,582 rows of order_items)', () => {
    const all = seqScan(1278, 157, () => 157)
    const steps = condense(all)
    expect(steps.length).toBeLessThanOrEqual(STEP_BUDGET)
    expectEveryEventOnce(steps, all.events.length)
  })

  it('takes a budget, so a smaller one makes bigger stretches', () => {
    const big = seqScan(1278, 157, () => 0)
    const small = condense(big, 100)
    expect(small.length).toBeLessThanOrEqual(100)
    expectEveryEventOnce(small, big.events.length)
  })

  it('doesn’t change the trace it condenses', () => {
    const big = seqScan(1278, 157, (page) => (page % 7 === 0 ? 1 : 0))
    const before = JSON.stringify(big)
    condense(big)
    expect(JSON.stringify(big)).toBe(before)
  })
})

describe('expanding and collapsing a stretch', () => {
  const steps: Step[] = [
    { start: 0, end: 1 },
    { start: 1, end: 5 },
    { start: 5, end: 6 },
  ]

  it('expands a stretch into exactly its events, one step each, remembering the stretch', () => {
    const expanded = expandStretch(steps, 1)
    expect(expanded).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2, stretch: { start: 1, end: 5 } },
      { start: 2, end: 3, stretch: { start: 1, end: 5 } },
      { start: 3, end: 4, stretch: { start: 1, end: 5 } },
      { start: 4, end: 5, stretch: { start: 1, end: 5 } },
      { start: 5, end: 6 },
    ])
    // A step of one event has nothing to expand.
    expect(expandStretch(steps, 0)).toBe(steps)
  })

  it('collapses from any of its events back into the one step, and says where it is', () => {
    const expanded = expandStretch(steps, 1)
    expect(collapseStretch(expanded, 3)).toEqual({ steps, index: 1 })
    expect(collapseStretch(expanded, 1)).toEqual({ steps, index: 1 })
    expect(collapseStretch(expanded, 4)).toEqual({ steps, index: 1 })
  })

  it('maps the player’s position to the events that have happened, condensed or expanded', () => {
    expect(eventsDone(steps, 0)).toBe(0)
    expect(eventsDone(steps, 1)).toBe(1)
    expect(eventsDone(steps, 2)).toBe(5)
    expect(eventsDone(steps, 3)).toBe(6)
    const expanded = expandStretch(steps, 1)
    expect([0, 1, 2, 3, 4, 5, 6].map((position) => eventsDone(expanded, position))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})

describe('condensing a Nested Loop with a Join Filter', () => {
  /** 60 loops of an inner Seq Scan of one page with 20 rows; the Join Filter passes one pair in each loop. */
  function joinFilterTrace(): Trace {
    const events: TraceEvent[] = [{ type: 'node.start', node: 0 }, { type: 'node.start', node: 1 }]
    const page = { relation: TABLE, block: 0 }
    let resultIndex = 0
    for (let loop = 1; loop <= 60; loop++) {
      const outer = [{ relation: TABLE, block: 1, offset: loop }]
      events.push({ type: 'row.emit', node: 1, row: outer[0], resultIndex: null })
      events.push({ type: 'join.loop', node: 0, loop, outer, params: [] })
      events.push({ type: 'node.start', node: 2 }, { type: 'buffer.hit', node: 2, page })
      events.push({ type: 'heap.page', node: 2, page, visibleRows: 20, matchedRows: 20 })
      for (let offset = 1; offset <= 20; offset++) {
        const row = { relation: TABLE, block: 0, offset }
        const matched = offset === loop % 20
        events.push({ type: 'row.emit', node: 2, row, resultIndex: null })
        events.push({ type: 'join.filter', node: 0, outer, row, matched })
        if (matched) events.push({ type: 'row.emit', node: 0, row, outer, resultIndex: resultIndex++ })
      }
      events.push({ type: 'node.finish', node: 2 })
    }
    events.push({ type: 'node.finish', node: 1 }, { type: 'node.finish', node: 0 })
    return trace(events)
  }

  it('keeps each Join Filter check with the row it checks: no step starts with one', () => {
    const t = joinFilterTrace()
    expect(t.events.length).toBeGreaterThan(STEP_BUDGET)
    const steps = condense(t)
    expectEveryEventOnce(steps, t.events.length)
    expect(steps.length).toBeLessThanOrEqual(STEP_BUDGET)
    expect(steps.filter((step) => t.events[step.start].type === 'join.filter')).toEqual([])
  })
})
