import { describe, expect, it } from 'vitest'
import type { Trace, TraceEvent } from '../replay/trace'
import { condense, eventsDone, expandStretch, isStretch, type Step } from './condense'
import { isJumpTarget, landOnEvent, nextEvent } from './jump'

const TABLE = 16384
const page = (block: number) => ({ relation: TABLE, block })
const row = (block: number, offset: number) => ({ relation: TABLE, block, offset })

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

// A Limit over a Seq Scan: rows passed up to the Limit, then on to the result.
const LIMITED = trace([
  { type: 'node.start', node: 0 }, // 0
  { type: 'node.start', node: 1 }, // 1
  { type: 'buffer.read', node: 1, page: page(0) }, // 2
  { type: 'buffer.read', node: 1, page: page(1), ahead: true }, // 3
  { type: 'heap.page', node: 1, page: page(0), visibleRows: 10, matchedRows: 2 }, // 4
  { type: 'row.emit', node: 1, row: row(0, 1), resultIndex: null }, // 5
  { type: 'row.emit', node: 0, row: row(0, 1), resultIndex: 0 }, // 6
  { type: 'buffer.hit', node: 1, page: page(0) }, // 7
  { type: 'limit.stop', node: 0, stopped: [1] }, // 8
  { type: 'node.finish', node: 0 }, // 9
])

describe('jump targets', () => {
  it('a row is a row sent to the result, not one passed up to a parent', () => {
    expect(nextEvent(LIMITED, 0, 'row')).toBe(6)
    expect(isJumpTarget(LIMITED.events[5], 'row')).toBe(false)
  })

  it('a page is a buffer access, hit or read, but not a page read ahead the scan never got to', () => {
    expect(nextEvent(LIMITED, 0, 'page')).toBe(2)
    expect(nextEvent(LIMITED, 3, 'page')).toBe(7)
  })

  it('a node is a node starting or finishing, or a Limit stopping the nodes below it', () => {
    expect(nextEvent(LIMITED, 0, 'node')).toBe(0)
    expect(nextEvent(LIMITED, 2, 'node')).toBe(8)
    expect(nextEvent(LIMITED, 9, 'node')).toBe(9)
  })

  it('searches from the first event not yet played, and finds nothing past the last', () => {
    expect(nextEvent(LIMITED, 7, 'row')).toBeNull()
    expect(nextEvent(LIMITED, 10, 'node')).toBeNull()
  })
})

describe('landOnEvent', () => {
  const steps: Step[] = [
    { start: 0, end: 1 },
    { start: 1, end: 4 },
    { start: 4, end: 5 },
    { start: 5, end: 8 },
  ]

  it('lands on a single-event step without changing the steps', () => {
    expect(landOnEvent(steps, 0, 4)).toEqual({ steps, position: 3 })
  })

  it('expands the stretch holding the event, and lands on that event alone', () => {
    const landing = landOnEvent(steps, 0, 6)
    expect(landing.steps).toEqual(expandStretch(steps, 3))
    expect(landing.position).toBe(5)
    const step = landing.steps[landing.position - 1]
    expect(step).toEqual({ start: 6, end: 7, stretch: { start: 5, end: 8 } })
    expect(eventsDone(landing.steps, landing.position)).toBe(7)
  })

  it('keeps a stretch expanded elsewhere when landing in a later one', () => {
    // The stretch of events 1 to 3 expanded, the player before it at the start.
    const expanded = expandStretch(steps, 1)
    const landing = landOnEvent(expanded, 0, 7)
    expect(landing.steps.filter((step) => step.stretch?.start === 1)).toHaveLength(3)
    expect(landing.steps[landing.position - 1]).toEqual({ start: 7, end: 8, stretch: { start: 5, end: 8 } })
  })

  it('collapses the expanded stretch it leaves, and stays in one when the event is inside it', () => {
    const expanded = expandStretch(steps, 1)
    // On event 1, the first of the expanded stretch 1 to 3: event 2 is inside it.
    const inside = landOnEvent(expanded, 2, 2)
    expect(inside).toEqual({ steps: expanded, position: 3 })
    // From event 2 to event 6: the stretch 1 to 3 is one step again, and 5 to 7 is expanded.
    const landing = landOnEvent(expanded, 3, 6)
    expect(landing.steps).toEqual(expandStretch(steps, 3))
    expect(landing.steps[landing.position - 1]).toEqual({ start: 6, end: 7, stretch: { start: 5, end: 8 } })
  })

  it('lands on every row and every page of a condensed trace, that event the last one done', () => {
    // 2,000 pages of a Seq Scan, a row matching every 50th: condensed, with rows in stretches.
    const events: TraceEvent[] = [{ type: 'node.start', node: 0 }]
    let resultIndex = 0
    for (let block = 0; block < 2000; block++) {
      events.push({ type: 'buffer.read', node: 0, page: page(block) })
      const matched = block % 50 === 0 ? 1 : 0
      events.push({ type: 'heap.page', node: 0, page: page(block), visibleRows: 100, matchedRows: matched })
      if (matched) events.push({ type: 'row.emit', node: 0, row: row(block, 1), resultIndex: resultIndex++ })
    }
    events.push({ type: 'node.finish', node: 0 })
    const long = trace(events)
    let list = condense(long)
    expect(list.some(isStretch)).toBe(true)
    let position = 0
    let rows = 0
    for (;;) {
      const next = nextEvent(long, eventsDone(list, position), 'row')
      if (next === null) break
      ;({ steps: list, position } = landOnEvent(list, position, next))
      expect(eventsDone(list, position)).toBe(next + 1)
      expect(isStretch(list[position - 1])).toBe(false)
      rows++
    }
    expect(rows).toBe(40)

    // Jumping page by page expands each stretch on the way, and collapses it on leaving.
    list = condense(long)
    position = 0
    let pages = 0
    for (;;) {
      const next = nextEvent(long, eventsDone(list, position), 'page')
      if (next === null) break
      ;({ steps: list, position } = landOnEvent(list, position, next))
      expect(eventsDone(list, position)).toBe(next + 1)
      expect(list.filter((step) => step.stretch !== undefined).length).toBeLessThan(10)
      pages++
    }
    expect(pages).toBe(2000)
  })
})
