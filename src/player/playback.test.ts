import { describe, expect, it } from 'vitest'
import type { Trace, TraceEvent } from '../replay/trace'
import { SHOWN_ROWS, formatIndexKey, formatKey, nodeProgressAt, resultRowsAt, stateAt, type NodeInfo } from './playback'

const TABLE = 10
const INDEX = 20
const relations: Trace['relations'] = [
  { id: TABLE, name: 'orders', kind: 'table', pages: 412 },
  { id: INDEX, name: 'orders_pkey', kind: 'index', pages: 140 },
]

function trace(events: TraceEvent[]): Trace {
  return { relations, events, indexPages: [] }
}

function nodes(info: Partial<NodeInfo> = {}) {
  return new Map<number, NodeInfo>([[0, { title: 'Index Scan using orders_pkey on orders', hasFilter: false, ...info }]])
}

const heapPage = (block: number) => ({ relation: TABLE, block })
const indexPage = (block: number) => ({ relation: INDEX, block })
const row = (block: number, offset: number) => ({ relation: TABLE, block, offset })

/** Example 1 as the replay engine traces it: root, one leaf, one heap row. */
const lookup = trace([
  { type: 'node.start', node: 0 },
  { type: 'index.search', node: 0, index: INDEX },
  { type: 'buffer.read', node: 0, page: indexPage(3) },
  { type: 'index.visit', node: 0, page: indexPage(3), level: 1, downlink: 2 },
  { type: 'buffer.read', node: 0, page: indexPage(57) },
  { type: 'index.visit', node: 0, page: indexPage(57), level: 0, downlink: null },
  { type: 'index.entry', node: 0, page: indexPage(57), offset: 7, key: ['42'], row: row(212, 4) },
  { type: 'buffer.read', node: 0, page: heapPage(212) },
  { type: 'heap.tuple', node: 0, row: row(212, 4), visible: row(212, 4), matched: true },
  { type: 'row.emit', node: 0, row: row(212, 4), resultIndex: 0 },
  { type: 'node.finish', node: 0 },
])

describe('the state at a step', () => {
  it('starts empty, with a caption saying how many steps there are', () => {
    const state = stateAt(lookup, nodes(), 0)
    expect(state).toMatchObject({ position: 0, current: null, hits: 0, reads: 0, resultRows: 0, heap: null, index: null })
    expect(state.table?.name).toBe('orders')
    expect(state.caption).toBe('Ready to replay 11 steps. Press play, or step through them one at a time.')
  })

  it('follows a search down the index, with a caption for each step', () => {
    const captions = Array.from({ length: 11 }, (_, i) => stateAt(lookup, nodes(), i + 1).caption)
    expect(captions).toEqual([
      'Index Scan using orders_pkey on orders starts.',
      'The scan searches orders_pkey from its root for the first entry that can match.',
      'Index page 3 isn’t in shared buffers, so it’s read from disk into a buffer.',
      'On index page 3 (the root), the search follows item 2 down to the page below.',
      'Index page 57 isn’t in shared buffers, so it’s read from disk into a buffer.',
      'The search reaches leaf index page 57, and looks for the first entry that can match.',
      'Entry 42 (item 7) matches; it points at row (212,4).',
      'Heap page 212 isn’t in shared buffers, so it’s read from disk into a buffer.',
      'Row (212,4) is visible to this query.',
      'Row (212,4) goes to the result as row 1.',
      'Index Scan using orders_pkey on orders has no more rows: it sent 1 row to the result.',
    ])
  })

  it('at the end, holds the path walked, the entry, the row and every counter', () => {
    const state = stateAt(lookup, nodes(), 11)
    expect(state.index).toMatchObject({
      searches: 1,
      path: [
        { page: indexPage(3), level: 1, downlink: 2 },
        { page: indexPage(57), level: 0, downlink: null },
      ],
      leaf: indexPage(57),
      entries: [{ offset: 7, key: ['42'], row: row(212, 4) }],
      entryCount: 1,
      matchedOffsets: [7],
    })
    expect(state.heap).toMatchObject({
      page: heapPage(212),
      rows: [{ row: row(212, 4), outcome: 'emitted', resultIndex: 0 }],
    })
    expect(state).toMatchObject({ reads: 3, hits: 0, resultRows: 1, activeNode: null, lastNode: 0 })
    expect(state.buffers.map((slot) => [slot.page.relation, slot.page.block, slot.wasCached])).toEqual([
      [INDEX, 3, false],
      [INDEX, 57, false],
      [TABLE, 212, false],
    ])
    expect([...state.pageMarks]).toEqual([[212, 'result']])
  })

  it('stepping back gives the same state as stepping forward to that step', () => {
    const forward = stateAt(lookup, nodes(), 6)
    expect(stateAt(lookup, nodes(), 6)).toEqual(forward)
    expect(forward).toMatchObject({ position: 6, reads: 2, activeNode: 0, resultRows: 0 })
    expect(forward.heap).toBeNull()
    // Out-of-range positions are clamped.
    expect(stateAt(lookup, nodes(), 99).position).toBe(11)
    expect(stateAt(lookup, nodes(), -1).position).toBe(0)
  })

  it('counts a hit once per access, and a page in buffers once', () => {
    const state = stateAt(
      trace([
        { type: 'node.start', node: 0 },
        { type: 'buffer.hit', node: 0, page: heapPage(0) },
        { type: 'buffer.hit', node: 0, page: heapPage(0) },
        { type: 'buffer.read', node: 0, page: heapPage(1) },
      ]),
      nodes(),
      4,
    )
    expect(state).toMatchObject({ hits: 2, reads: 1 })
    expect(state.buffers.map((slot) => [slot.page.block, slot.wasCached])).toEqual([
      [0, true],
      [1, false],
    ])
    expect(state.caption).toBe('Heap page 1 isn’t in shared buffers, so it’s read from disk into a buffer.')
    expect(stateAt(trace([{ type: 'buffer.hit', node: 0, page: heapPage(0) }]), nodes(), 1).caption).toBe(
      'Heap page 0 is already in shared buffers: a hit, no disk read.',
    )
  })

  it('says when a scan moves right to the next leaf, and when it searches again from the root', () => {
    const events: TraceEvent[] = [
      { type: 'index.search', node: 0, index: INDEX },
      { type: 'index.visit', node: 0, page: indexPage(3), level: 1, downlink: 1 },
      { type: 'index.visit', node: 0, page: indexPage(1), level: 0, downlink: null },
      { type: 'index.entry', node: 0, page: indexPage(1), offset: 2, key: ['5', null], row: row(0, 5) },
      { type: 'index.visit', node: 0, page: indexPage(2), level: 0, downlink: null },
      { type: 'index.search', node: 0, index: INDEX },
    ]
    const right = stateAt(trace(events), nodes(), 5)
    expect(right.caption).toBe('More entries could match on the next leaf, so the scan moves right to index page 2.')
    expect(right.index).toMatchObject({ leaf: indexPage(2), entries: [], entryCount: 0, matchedOffsets: [] })
    expect(stateAt(trace(events), nodes(), 4).index?.matchedOffsets).toEqual([2])
    expect(right.index?.path.map((step) => step.page.block)).toEqual([3, 1, 2])

    const again = stateAt(trace(events), nodes(), 6)
    expect(again.caption).toBe('The scan searches orders_pkey again from the root (search 2), for the next values it needs.')
    expect(again.index).toMatchObject({ searches: 2, path: [], leaf: null })
  })

  it('shows a Seq Scan page: rows visible, rows that passed, and the ones emitted', () => {
    const seqScan = trace([
      { type: 'node.start', node: 0 },
      { type: 'buffer.read', node: 0, page: heapPage(37) },
      { type: 'heap.page', node: 0, page: heapPage(37), visibleRows: 150, matchedRows: 2 },
      { type: 'row.emit', node: 0, row: row(37, 4), resultIndex: 0 },
      { type: 'row.emit', node: 0, row: row(37, 90), resultIndex: 1 },
      { type: 'buffer.read', node: 0, page: heapPage(38) },
    ])
    const filtered = nodes({ title: 'Seq Scan on orders', hasFilter: true })
    expect(stateAt(seqScan, filtered, 3).caption).toBe('Heap page 37: 150 rows visible to the query, checked against the filter; 2 pass.')
    expect(stateAt(seqScan, nodes({ hasFilter: false }), 3).caption).toBe(
      'Heap page 37: 150 rows visible to the query; with no filter, every one goes to the result.',
    )
    const done = stateAt(seqScan, filtered, 5)
    expect(done.heap).toMatchObject({ page: heapPage(37), visibleRows: 150, matchedRows: 2, rowCount: 2 })
    expect(done.heap?.rows.map((shown) => [shown.row.offset, shown.outcome, shown.resultIndex])).toEqual([
      [4, 'emitted', 0],
      [90, 'emitted', 1],
    ])
    expect(done.caption).toBe('Row (37,90) goes to the result as row 2.')
    expect(done.index).toBeNull()

    // The next page starts a fresh view; the mini-map remembers both.
    const next = stateAt(seqScan, filtered, 6)
    expect(next.heap).toMatchObject({ page: heapPage(38), rows: [], visibleRows: null })
    expect([...next.pageMarks]).toEqual([
      [37, 'result'],
      [38, 'touched'],
    ])
  })

  it('marks rows that fail the filter, aren’t visible, or were updated on the same page', () => {
    const fetched = trace([
      { type: 'buffer.read', node: 0, page: heapPage(5) },
      { type: 'heap.tuple', node: 0, row: row(5, 1), visible: row(5, 1), matched: false },
      { type: 'heap.tuple', node: 0, row: row(5, 2), visible: null, matched: false },
      { type: 'heap.tuple', node: 0, row: row(5, 3), visible: row(5, 9), matched: true },
      { type: 'row.emit', node: 0, row: row(5, 9), resultIndex: 0 },
    ])
    const filtered = nodes({ hasFilter: true })
    expect(stateAt(fetched, filtered, 2).caption).toBe('Row (5,1) is visible to this query, but it fails the filter, so it’s rejected.')
    expect(stateAt(fetched, filtered, 3).caption).toBe(
      'Row (5,2) isn’t visible to this query (deleted, or not yet committed), so it’s skipped.',
    )
    expect(stateAt(fetched, filtered, 4).caption).toBe(
      'Row (5,3) was updated on the same page; this query sees the newer version, (5,9), and it passes the filter.',
    )
    expect(stateAt(fetched, filtered, 5).heap?.rows.map((shown) => [shown.row.offset, shown.visible?.offset ?? null, shown.outcome])).toEqual([
      [1, null, 'rejected'],
      [2, null, 'invisible'],
      [3, 9, 'emitted'],
    ])
  })

  it('lists only the latest rows and entries, and counts them all', () => {
    const events: TraceEvent[] = [
      { type: 'index.search', node: 0, index: INDEX },
      { type: 'index.visit', node: 0, page: indexPage(1), level: 0, downlink: null },
      { type: 'buffer.read', node: 0, page: heapPage(0) },
    ]
    for (let offset = 1; offset <= 10; offset++) {
      events.push({ type: 'index.entry', node: 0, page: indexPage(1), offset, key: [String(offset)], row: row(0, offset) })
      events.push({ type: 'heap.tuple', node: 0, row: row(0, offset), visible: row(0, offset), matched: true })
      events.push({ type: 'row.emit', node: 0, row: row(0, offset), resultIndex: offset - 1 })
    }
    const state = stateAt(trace(events), nodes(), events.length)
    expect(state.index?.entryCount).toBe(10)
    expect(state.index?.entries.map((entry) => entry.offset)).toEqual([5, 6, 7, 8, 9, 10])
    // Every match is remembered for the page box, not just the latest.
    expect(state.index?.matchedOffsets).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(state.heap?.rowCount).toBe(10)
    expect(state.heap?.rows).toHaveLength(SHOWN_ROWS)
    expect(state.heap?.rows.every((shown) => shown.outcome === 'emitted')).toBe(true)
    expect(state.resultRows).toBe(10)
  })

  it('counts entries marked dead', () => {
    const state = stateAt(
      trace([
        { type: 'index.search', node: 0, index: INDEX },
        { type: 'index.markDead', node: 0, page: indexPage(4), offsets: [3, 4] },
      ]),
      nodes(),
      2,
    )
    expect(state.index?.markedDead).toBe(2)
    expect([...(state.index?.deadEntries ?? [])]).toEqual(['4/3', '4/4'])
    expect(state.caption).toBe(
      'No transaction can see the rows of 2 entries on index page 4 any more, so the scan marks them dead; later scans skip them.',
    )
  })
})

describe('the rows sent to the result by a step', () => {
  it('counts the rows emitted to the result, not those passed to a parent node', () => {
    const events: TraceEvent[] = [
      { type: 'node.start', node: 0 },
      { type: 'row.emit', node: 1, row: row(1, 1), resultIndex: null },
      { type: 'row.emit', node: 0, row: row(1, 1), resultIndex: 0 },
      { type: 'row.emit', node: 1, row: row(1, 2), resultIndex: null },
      { type: 'row.emit', node: 0, row: row(1, 2), resultIndex: 1 },
      { type: 'node.finish', node: 0 },
    ]
    expect([0, 1, 2, 3, 4, 5, 6].map((position) => resultRowsAt(trace(events), position))).toEqual([0, 0, 0, 1, 1, 2, 2])
  })

  it('agrees with the state at every step, and stays within the trace', () => {
    for (let position = 0; position <= lookup.events.length; position++) {
      expect(resultRowsAt(lookup, position)).toBe(stateAt(lookup, nodes(), position).resultRows)
    }
    expect(resultRowsAt(lookup, -1)).toBe(0)
    expect(resultRowsAt(lookup, 100)).toBe(1)
  })
})

describe('each plan node’s progress at a step', () => {
  it('follows example 1’s one node from waiting to active to done, counting its rows', () => {
    const at = (position: number) => nodeProgressAt(lookup, position).get(0)
    expect(at(0)).toEqual({ status: 'waiting', rows: 0 })
    expect(at(1)).toEqual({ status: 'active', rows: 0 })
    expect(at(9)).toEqual({ status: 'active', rows: 0 })
    expect(at(10)).toEqual({ status: 'active', rows: 1 })
    expect(at(11)).toEqual({ status: 'done', rows: 1 })
    expect(at(100)).toEqual({ status: 'done', rows: 1 })
  })

  it('keeps a parent active while its child works, and counts the rows each passes on', () => {
    // A parent (node 0) that pulls two rows from its child (node 1) and sends one on to the result.
    const events: TraceEvent[] = [
      { type: 'node.start', node: 0 },
      { type: 'node.start', node: 1 },
      { type: 'row.emit', node: 1, row: row(1, 1), resultIndex: null },
      { type: 'row.emit', node: 1, row: row(1, 2), resultIndex: null },
      { type: 'node.finish', node: 1 },
      { type: 'row.emit', node: 0, row: row(1, 2), resultIndex: 0 },
      { type: 'node.finish', node: 0 },
    ]
    const at = (position: number) => Object.fromEntries(nodeProgressAt(trace(events), position))
    expect(at(0)).toEqual({ 0: { status: 'waiting', rows: 0 }, 1: { status: 'waiting', rows: 0 } })
    expect(at(4)).toEqual({ 0: { status: 'active', rows: 0 }, 1: { status: 'active', rows: 2 } })
    expect(at(6)).toEqual({ 0: { status: 'active', rows: 1 }, 1: { status: 'done', rows: 2 } })
    expect(at(7)).toEqual({ 0: { status: 'done', rows: 1 }, 1: { status: 'done', rows: 2 } })
  })
})

describe('formatKey', () => {
  it('writes one column as it is, several in parentheses, and NULL as NULL', () => {
    expect(formatKey(['42'])).toBe('42')
    expect(formatKey(['777', '2'])).toBe('(777, 2)')
    expect(formatKey([null])).toBe('NULL')
  })
})

describe('formatIndexKey', () => {
  it('writes a key as Postgres wrote its values, minus infinity for what a downlink dropped', () => {
    expect(formatIndexKey(['4242'], 1)).toBe('4242')
    expect(formatIndexKey(['777', '2'], 2)).toBe('(777, 2)')
    // Suffix truncation kept only the first column.
    expect(formatIndexKey(['777'], 2)).toBe('(777, −∞)')
    // A page's first downlink keeps no key at all.
    expect(formatIndexKey([], 2)).toBe('−∞')
    expect(formatIndexKey([null, 'Mary'], 2)).toBe('(NULL, Mary)')
  })
})
