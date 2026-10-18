import { describe, expect, it } from 'vitest'
import type { Trace, TraceEvent } from '../replay/trace'
import { SHOWN_ROWS, formatIndexKey, formatKey, nodeProgressAt, resultRowsAt, shortKey, stateAt, type NodeInfo } from './playback'

const TABLE = 10
const INDEX = 20
const relations: Trace['relations'] = [
  { id: TABLE, name: 'orders', kind: 'table', pages: 412 },
  { id: INDEX, name: 'orders_pkey', kind: 'index', pages: 140 },
]

function trace(events: TraceEvent[]): Trace {
  return { relations, events, indexPages: [], sorts: [], limits: [], heapPages: [] }
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
    // Each slot counts its own hits and reads, for its hover text.
    expect(state.buffers.map((slot) => [slot.page.block, slot.wasCached, slot.hits, slot.reads])).toEqual([
      [0, true, 2, 0],
      [1, false, 0, 1],
    ])
    // A page read, then asked for again: one read and one hit.
    const again = stateAt(
      trace([
        { type: 'buffer.read', node: 0, page: heapPage(1) },
        { type: 'buffer.hit', node: 0, page: heapPage(1) },
      ]),
      nodes(),
      2,
    )
    expect(again.buffers.map((slot) => [slot.wasCached, slot.hits, slot.reads])).toEqual([[false, 1, 1]])
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
  /** An index-only scan: one entry on an all-visible page, then one on a page that isn't, whose row is fetched. */
  const indexOnly = trace([
    { type: 'node.start', node: 0 },
    { type: 'index.entry', node: 0, page: indexPage(57), offset: 7, key: ['42'], row: row(119, 59) },
    { type: 'buffer.read', node: 0, page: { relation: TABLE, block: 0, fork: 'vm' } },
    { type: 'visibility.check', node: 0, page: heapPage(119), row: row(119, 59), allVisible: true, matched: true },
    { type: 'row.emit', node: 0, row: row(119, 59), resultIndex: 0 },
    { type: 'index.entry', node: 0, page: indexPage(57), offset: 8, key: ['42'], row: row(588, 74) },
    { type: 'visibility.check', node: 0, page: heapPage(588), row: row(588, 74), allVisible: false, matched: null },
    { type: 'buffer.read', node: 0, page: heapPage(588) },
    { type: 'heap.tuple', node: 0, row: row(588, 74), visible: row(588, 74), matched: true },
    { type: 'row.emit', node: 0, row: row(588, 74), resultIndex: 1 },
    { type: 'node.finish', node: 0 },
  ])
  const indexOnlyNodes = nodes({ title: 'Index Only Scan using orders_customer_id_order_date_idx on orders' })

  it('an index-only scan: reads the visibility map, and skips the heap for an all-visible page', () => {
    const caption = (position: number) => stateAt(indexOnly, indexOnlyNodes, position).caption
    expect(caption(3)).toBe('Visibility map page 0 isn’t in shared buffers, so it’s read from disk into a buffer.')
    expect(caption(4)).toBe(
      'The visibility map marks heap page 119 all-visible (every row on it is visible to every transaction), so the entry’s values are enough: row (119,59) isn’t fetched from the heap.',
    )
    expect(caption(7)).toBe(
      'The visibility map doesn’t mark heap page 588 all-visible, so the scan fetches row (588,74) from the heap to check this query can see it.',
    )

    // The map's page 0 is a slot of its own, not heap page 0, and doesn't make the heap zone show a page.
    const afterMap = stateAt(indexOnly, indexOnlyNodes, 3)
    expect(afterMap.buffers.map((slot) => slot.page)).toEqual([{ relation: TABLE, block: 0, fork: 'vm' }])
    expect(afterMap.heap).toBeNull()
    expect(afterMap.pageMarks.size).toBe(0)

    const skipped = stateAt(indexOnly, indexOnlyNodes, 5)
    expect(skipped.heap).toMatchObject({ page: heapPage(119), allVisible: true, rows: [{ outcome: 'emitted', resultIndex: 0 }] })
    expect(skipped.pageMarks.get(119)).toBe('fromIndex')

    const end = stateAt(indexOnly, indexOnlyNodes, indexOnly.events.length)
    expect(end.heap).toMatchObject({ page: heapPage(588), allVisible: false, rows: [{ outcome: 'emitted', resultIndex: 1 }] })
    // A page the scan didn't read keeps its own mark, though rows from it went to the result.
    expect([...end.pageMarks]).toEqual([
      [119, 'fromIndex'],
      [588, 'result'],
    ])
    expect(end.resultRows).toBe(2)
  })

  it('an index-only scan: an all-visible page’s entry that fails the filter is rejected without a fetch', () => {
    const rejected = trace([
      { type: 'visibility.check', node: 0, page: heapPage(119), row: row(119, 59), allVisible: true, matched: false },
    ])
    const state = stateAt(rejected, nodes({ hasFilter: true }), 1)
    expect(state.heap?.rows).toEqual([{ row: row(119, 59), visible: null, outcome: 'rejected', resultIndex: null, to: null }])
    expect(state.caption).toBe(
      'The visibility map marks heap page 119 all-visible (every row on it is visible to every transaction), so the entry’s values are enough: row (119,59) isn’t fetched from the heap. Its values fail the filter, so it’s rejected.',
    )
  })
})

describe('the state of a bitmap scan at a step', () => {
  const bitmapNodes = new Map<number, NodeInfo>([
    [0, { title: 'Bitmap Heap Scan on orders', hasFilter: false }],
    [1, { title: 'Bitmap Index Scan on orders_pkey', hasFilter: false }],
  ])
  /** The index scan marks 3 rows on 2 heap pages; the heap scan reads them in physical order. */
  const bitmapScan = trace([
    { type: 'node.start', node: 0 },
    { type: 'node.start', node: 1 },
    { type: 'index.search', node: 1, index: INDEX },
    { type: 'buffer.read', node: 1, page: indexPage(3) },
    { type: 'index.visit', node: 1, page: indexPage(3), level: 1, downlink: 2 },
    { type: 'buffer.read', node: 1, page: indexPage(57) },
    { type: 'index.visit', node: 1, page: indexPage(57), level: 0, downlink: null },
    { type: 'index.entry', node: 1, page: indexPage(57), offset: 7, key: ['42'], row: row(212, 4), bitmap: true },
    { type: 'index.entry', node: 1, page: indexPage(57), offset: 8, key: ['42'], row: row(30, 2), bitmap: true },
    { type: 'index.entry', node: 1, page: indexPage(57), offset: 9, key: ['43'], row: row(212, 1), bitmap: true },
    { type: 'node.finish', node: 1 },
    { type: 'buffer.read', node: 0, page: heapPage(30) },
    { type: 'heap.tuple', node: 0, row: row(30, 2), visible: row(30, 2), matched: true },
    { type: 'row.emit', node: 0, row: row(30, 2), resultIndex: 0 },
    { type: 'buffer.hit', node: 0, page: heapPage(212) },
    { type: 'heap.tuple', node: 0, row: row(212, 1), visible: null, matched: false },
    { type: 'heap.tuple', node: 0, row: row(212, 4), visible: row(212, 4), matched: true },
    { type: 'row.emit', node: 0, row: row(212, 4), resultIndex: 1 },
    { type: 'node.finish', node: 0 },
  ])

  it('builds the bitmap, then reads its pages in order, with a caption for each step', () => {
    const captions = bitmapScan.events.map((_, i) => stateAt(bitmapScan, bitmapNodes, i + 1).caption)
    expect(captions).toEqual([
      'Bitmap Heap Scan on orders starts.',
      'Bitmap Index Scan on orders_pkey starts.',
      'The scan searches orders_pkey from its root for the first entry that can match.',
      'Index page 3 isn’t in shared buffers, so it’s read from disk into a buffer.',
      'On index page 3 (the root), the search follows item 2 down to the page below.',
      'Index page 57 isn’t in shared buffers, so it’s read from disk into a buffer.',
      'The search reaches leaf index page 57, and looks for the first entry that can match.',
      'Entry 42 (item 7) matches; the scan marks its row, (212,4), in the bitmap instead of fetching it (heap page 212: 1 row marked).',
      'Entry 42 (item 8) matches; the scan marks its row, (30,2), in the bitmap instead of fetching it (heap page 30: 1 row marked).',
      'Entry 43 (item 9) matches; the scan marks its row, (212,1), in the bitmap instead of fetching it (heap page 212: 2 rows marked).',
      'Bitmap Index Scan on orders_pkey is done: its bitmap marks 3 rows on 2 heap pages. Bitmap Heap Scan on orders reads those pages next, in physical order, each one once.',
      'Heap page 30, page 1 of 2 in the bitmap, has 1 row marked. It isn’t in shared buffers, so it’s read from disk into a buffer.',
      'Row (30,2) is visible to this query.',
      'Row (30,2) goes to the result as row 1.',
      'Heap page 212, page 2 of 2 in the bitmap, has 2 rows marked. It is already in shared buffers: a hit, no disk read.',
      'Row (212,1) isn’t visible to this query (deleted, or not yet committed), so it’s skipped.',
      'Row (212,4) is visible to this query.',
      'Row (212,4) goes to the result as row 2.',
      'Bitmap Heap Scan on orders has no more rows: it sent 2 rows to the result.',
    ])
  })

  it('marks the bitmap’s pages on the mini-map before any is read, then each as it’s read', () => {
    const built = stateAt(bitmapScan, bitmapNodes, 10)
    expect(built.bitmap).toEqual({
      node: 1,
      pages: new Map([
        [212, [4, 1]],
        [30, [2]],
      ]),
      rows: 3,
      pagesRead: 0,
    })
    expect([...built.pageMarks]).toEqual([
      [212, 'bitmap'],
      [30, 'bitmap'],
    ])
    expect(built.heap).toBeNull()
    expect(built.index?.entries.map((entry) => entry.bitmap)).toEqual([true, true, true])
    expect(built.nodeRows).toEqual(new Map([[1, 3]]))

    const firstPage = stateAt(bitmapScan, bitmapNodes, 12)
    expect(firstPage.heap).toMatchObject({ page: heapPage(30), bitmapRows: 1, rows: [] })
    expect(firstPage.bitmap?.pagesRead).toBe(1)
    expect(firstPage.pageMarks.get(30)).toBe('touched')
    expect(firstPage.pageMarks.get(212)).toBe('bitmap')

    const end = stateAt(bitmapScan, bitmapNodes, bitmapScan.events.length)
    expect(end.heap).toMatchObject({ page: heapPage(212), bitmapRows: 2, rowCount: 2 })
    expect(end.heap?.rows.map((each) => each.outcome)).toEqual(['invisible', 'emitted'])
    expect(end.bitmap?.pagesRead).toBe(2)
    expect([...end.pageMarks]).toEqual([
      [212, 'result'],
      [30, 'result'],
    ])
    expect(end.nodeRows).toEqual(new Map([[1, 3], [0, 2]]))
  })

  it('makes the parent the active node again when its child finishes', () => {
    const active = (position: number) => stateAt(bitmapScan, bitmapNodes, position).activeNode
    expect([0, 1, 2, 10, 11, 12, 18, 19].map(active)).toEqual([null, 0, 1, 1, 0, 0, 0, null])
    expect(stateAt(bitmapScan, bitmapNodes, 11).lastNode).toBe(1)
  })

  it('counts the rows a bitmap index scan marks as the rows it passes on, in the plan tree too', () => {
    expect(Object.fromEntries(nodeProgressAt(bitmapScan, 11))).toEqual({
      0: { status: 'active', rows: 0 },
      1: { status: 'done', rows: 3 },
    })
    expect(resultRowsAt(bitmapScan, 11)).toBe(0)
  })

  it('a bitmap index scan that finds nothing passes no rows up to its parent', () => {
    const empty = trace([
      { type: 'node.start', node: 0 },
      { type: 'node.start', node: 1 },
      { type: 'index.search', node: 1, index: INDEX },
      { type: 'buffer.read', node: 1, page: indexPage(3) },
      { type: 'index.visit', node: 1, page: indexPage(3), level: 0, downlink: null },
      { type: 'node.finish', node: 1 },
      { type: 'node.finish', node: 0 },
    ])
    expect(stateAt(empty, bitmapNodes, 6).caption).toBe(
      'Bitmap Index Scan on orders_pkey has no more rows: it passed 0 rows up to Bitmap Heap Scan on orders.',
    )
    expect(stateAt(empty, bitmapNodes, 6).bitmap).toBeNull()
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

/** Plan nodes for a Limit (0) over a Sort (1) over a Seq Scan (2), or a Limit (0) over an index scan (1). */
function planNodes(entries: [number, string, number?][]) {
  return new Map<number, NodeInfo>(entries.map(([id, title, parent]) => [id, { title, hasFilter: false, parent }]))
}

describe('a Limit over a scan', () => {
  const scanTitle = 'Index Scan Backward using orders_customer_id_order_date_idx on orders'
  const limitNodes = planNodes([
    [0, 'Limit'],
    [1, scanTitle, 0],
  ])
  const limited: Trace = {
    ...trace([
      { type: 'node.start', node: 0 },
      { type: 'node.start', node: 1 },
      { type: 'index.search', node: 1, index: INDEX, backward: true },
      { type: 'buffer.read', node: 1, page: indexPage(3) },
      { type: 'index.visit', node: 1, page: indexPage(3), level: 1, downlink: 9 },
      { type: 'buffer.read', node: 1, page: indexPage(57) },
      { type: 'index.visit', node: 1, page: indexPage(57), level: 0, downlink: null },
      { type: 'buffer.read', node: 1, page: indexPage(56) },
      { type: 'index.visit', node: 1, page: indexPage(56), level: 0, downlink: null },
      { type: 'index.entry', node: 1, page: indexPage(56), offset: 7, key: ['42'], row: row(212, 4) },
      { type: 'buffer.read', node: 1, page: heapPage(212) },
      { type: 'heap.tuple', node: 1, row: row(212, 4), visible: row(212, 4), matched: true },
      { type: 'row.emit', node: 1, row: row(212, 4), resultIndex: null },
      { type: 'row.emit', node: 0, row: row(212, 4), resultIndex: 0 },
      { type: 'limit.stop', node: 0, stopped: [1] },
      { type: 'index.markDead', node: 1, page: indexPage(56), offsets: [3] },
      { type: 'node.finish', node: 0 },
    ]),
    limits: [{ node: 0, offset: 0, count: 1 }],
  }
  const captions = Array.from({ length: limited.events.length }, (_, i) => stateAt(limited, limitNodes, i + 1).caption)

  it('says a backward scan searches for the last entry, and moves left', () => {
    expect(captions[2]).toBe(
      'The scan reads orders_pkey backward, from high keys to low: it searches from the root for the last entry that can match.',
    )
    expect(captions[6]).toBe('The search reaches leaf index page 57, and looks for the last entry that can match.')
    expect(captions[8]).toBe('More entries could match on the next leaf, so the scan moves left to index page 56.')
    expect(stateAt(limited, limitNodes, 9).index?.backward).toBe(true)
  })

  it('passes each row up to the Limit, then to the result, and stops the scan when it has its LIMIT', () => {
    expect(captions[12]).toBe('Row (212,4) goes up to Limit.')
    expect(captions[13]).toBe('Row (212,4) goes to the result as row 1 (1 of the Limit’s 1).')
    expect(captions[14]).toBe(
      `Limit has passed on its 1 row (LIMIT 1), so it stops: it doesn’t ask ${scanTitle} for another row, which stops where it is.`,
    )
    // The stopped scan marks the dead entries it found as the query ends.
    expect(captions[15]).toBe(
      'As the query ends: no transaction can see the rows of 1 entry on index page 56 any more, so the scan marks it dead; later scans skip it.',
    )
  })

  it('shows the row going up, then to the result, once on the heap page; the Limit’s count; the scan stopped', () => {
    const up = stateAt(limited, limitNodes, 13)
    expect(up.heap?.rows).toEqual([{ row: row(212, 4), visible: null, outcome: 'up', resultIndex: null, to: 'Limit' }])
    expect(up.limit).toEqual({ node: 0, count: 1, offset: 0, skipped: 0, passed: 0, stopped: false })
    const sent = stateAt(limited, limitNodes, 14)
    expect(sent.heap?.rows).toEqual([{ row: row(212, 4), visible: null, outcome: 'emitted', resultIndex: 0, to: null }])
    expect(sent.limit?.passed).toBe(1)
    const stopped = stateAt(limited, limitNodes, 15)
    expect(stopped.limit?.stopped).toBe(true)
    expect(stopped.stopped).toEqual(new Set([1]))
    expect(stopped.activeNode).toBe(0)
    expect(Object.fromEntries(nodeProgressAt(limited, 15))).toEqual({
      0: { status: 'active', rows: 1 },
      1: { status: 'stopped', rows: 1 },
    })
  })

  it('skips rows for its OFFSET, and with LIMIT 0 asks for none', () => {
    const offset: Trace = {
      ...trace([
        { type: 'node.start', node: 0 },
        { type: 'node.start', node: 1 },
        { type: 'row.emit', node: 1, row: row(1, 1), resultIndex: null },
        { type: 'limit.skip', node: 0, row: row(1, 1) },
      ]),
      limits: [{ node: 0, offset: 2, count: 3 }],
    }
    expect(stateAt(offset, limitNodes, 4).caption).toBe('Limit skips row (1,1), for its OFFSET (1 of 2 skipped).')
    expect(stateAt(offset, limitNodes, 4).limit?.skipped).toBe(1)
    const none: Trace = {
      ...trace([
        { type: 'node.start', node: 0 },
        { type: 'limit.stop', node: 0, stopped: [] },
        { type: 'node.finish', node: 0 },
      ]),
      limits: [{ node: 0, offset: 0, count: 0 }],
    }
    expect(stateAt(none, limitNodes, 2).caption).toBe('Limit needs no rows (LIMIT 0), so it never asks the node below it for one.')
  })
})

describe('a Seq Scan a Limit stops', () => {
  const nodesBelow = planNodes([
    [0, 'Limit'],
    [1, 'Seq Scan on orders', 0],
  ])
  const stopped: Trace = {
    ...trace([
      { type: 'node.start', node: 0 },
      { type: 'node.start', node: 1 },
      { type: 'buffer.read', node: 1, page: heapPage(0) },
      { type: 'heap.page', node: 1, page: heapPage(0), visibleRows: 85, checkedRows: 10, matchedRows: 1 },
      { type: 'row.emit', node: 1, row: row(0, 10), resultIndex: null },
      { type: 'row.emit', node: 0, row: row(0, 10), resultIndex: 0 },
      { type: 'limit.stop', node: 0, stopped: [1] },
      { type: 'buffer.read', node: 1, page: heapPage(1), ahead: true },
      { type: 'buffer.hit', node: 1, page: heapPage(2), ahead: true },
      { type: 'node.finish', node: 0 },
    ]),
    limits: [{ node: 0, offset: 0, count: 1 }],
  }

  it('says how far into its last page it got', () => {
    const state = stateAt(stopped, nodesBelow, 4)
    expect(state.caption).toBe(
      'Heap page 0: 85 rows visible to the query. The scan goes through the first 10 only: with 1 row from it, Limit has all it needs.',
    )
    expect(state.heap?.checkedRows).toBe(10)
  })

  it('shows the pages it read ahead and never used, without making them the page being read', () => {
    const read = stateAt(stopped, nodesBelow, 8)
    expect(read.caption).toBe(
      'Heap page 1 had been read from disk into a buffer ahead of the scan, but the scan stopped before it got there. Postgres reads the pages a scan will need next in batches, and counts them all.',
    )
    const hit = stateAt(stopped, nodesBelow, 9)
    expect(hit.caption).toBe(
      'Heap page 2 had been pinned ahead of the scan (it was already in shared buffers: a hit), but the scan stopped before it got there. Postgres reads the pages a scan will need next in batches, and counts them all.',
    )
    expect(hit.heap?.page.block).toBe(0)
    expect(hit.buffers.map((slot) => [slot.page.block, slot.ahead])).toEqual([
      [0, false],
      [1, true],
      [2, true],
    ])
    expect(hit.pageMarks).toEqual(new Map([[0, 'result'], [1, 'ahead'], [2, 'ahead']]))
    expect([hit.reads, hit.hits]).toEqual([2, 1])
  })
})

describe('a Sort', () => {
  const sortNodes = planNodes([
    [0, 'Limit'],
    [1, 'Sort', 0],
    [2, 'Seq Scan on orders', 1],
  ])
  const sortRow = (block: number, offset: number, total: string, rank: number) => ({ row: row(block, offset), key: [total], rank })
  const rows = [sortRow(0, 1, '20.00', 3), sortRow(0, 2, '90.00', 1), sortRow(0, 3, '50.00', 2), sortRow(0, 4, '10.00', 4)]

  it('holds the rows it’s given, sorts them, then passes them on in order', () => {
    const quick: Trace = {
      ...trace([
        { type: 'node.start', node: 0 },
        { type: 'node.start', node: 1 },
        { type: 'node.start', node: 2 },
        { type: 'row.emit', node: 2, row: row(0, 1), resultIndex: null },
        { type: 'row.emit', node: 2, row: row(0, 2), resultIndex: null },
        { type: 'node.finish', node: 2 },
        { type: 'sort.done', node: 1, rows: 2, method: 'quicksort' },
        { type: 'row.emit', node: 1, row: row(0, 2), resultIndex: null },
        { type: 'row.emit', node: 0, row: row(0, 2), resultIndex: 0 },
      ]),
      sorts: [{ node: 1, keys: ['orders.total DESC'], rows: rows.slice(0, 2) }],
      limits: [{ node: 0, offset: 0, count: 5 }],
    }
    const at = (position: number) => stateAt(quick, sortNodes, position)
    expect(at(5).caption).toBe('Row (0,2) goes up to Sort, which holds it in memory with the others to sort them (2 rows so far).')
    expect(at(5).sort).toMatchObject({ method: null, received: 2, held: 2, sorted: false })
    // The Sort works while the scan below gives it rows, and goes on once the scan is done.
    expect(at(5).working).toEqual([0, 1, 2])
    expect(at(6).working).toEqual([0, 1])
    expect(at(5).sort?.rows.map((each) => [each.row.offset, each.key, each.latest])).toEqual([
      [1, ['20.00'], false],
      [2, ['90.00'], true],
    ])
    expect(at(7).caption).toBe(
      'Sort has all 2 rows from below: it sorts them in memory by orders.total DESC (a quicksort), then passes them up to Limit in that order.',
    )
    expect(at(8).caption).toBe('Row (0,2), 1st in sort order, goes up to Limit.')
    expect(at(8).sort).toMatchObject({ method: 'quicksort', sorted: true, passed: 1 })
    expect(at(8).sort?.rows).toEqual([{ row: row(0, 2), key: ['90.00'], position: 0, latest: true }])
  })

  it('in a top-N heapsort, keeps the best rows, with the worst last, and says what becomes of each new one', () => {
    const topN: Trace = {
      ...trace([
        { type: 'node.start', node: 0 },
        { type: 'node.start', node: 1 },
        { type: 'node.start', node: 2 },
        { type: 'row.emit', node: 2, row: row(0, 1), resultIndex: null },
        { type: 'row.emit', node: 2, row: row(0, 2), resultIndex: null },
        { type: 'row.emit', node: 2, row: row(0, 4), resultIndex: null },
        { type: 'sort.heap', node: 1, kept: [row(0, 1)], dropped: [row(0, 2), row(0, 4)] },
        { type: 'row.emit', node: 2, row: row(0, 3), resultIndex: null },
        { type: 'sort.keep', node: 1, row: row(0, 3), replaced: row(0, 1) },
      ]),
      // Ranks for an ascending sort here: (0,4) lowest; the heap keeps one row.
      sorts: [{ node: 1, keys: ['orders.total'], rows: [sortRow(0, 1, '20.00', 2), sortRow(0, 2, '90.00', 4), sortRow(0, 3, '15.00', 1.5), sortRow(0, 4, '10.00', 1)] }],
      limits: [{ node: 0, offset: 0, count: 1 }],
    }
    const at = (position: number) => stateAt(topN, sortNodes, position)
    expect(at(7).caption).toBe(
      'Sort holds 3 rows, more than twice the 1 the Limit above needs, so it switches to a top-N heapsort: it keeps the best 1, with the worst of them on top to compare new rows with, and drops the other 2.',
    )
    expect(at(7).sort).toMatchObject({ method: 'top-N heapsort', keeps: 1, held: 1, dropped: 2, received: 3 })
    expect(at(9).caption).toBe(
      'Row (0,3) (total 15.00) sorts before the worst row kept, (0,1) (total 20.00), so it takes its place, and (0,1) is dropped.',
    )
    expect(at(9).sort?.rows.map((each) => each.row.offset)).toEqual([3])
    expect(at(9).sort?.dropped).toBe(3)
    const discard: Trace = {
      ...topN,
      events: [...topN.events.slice(0, 7), { type: 'row.emit', node: 2, row: row(0, 2), resultIndex: null }, { type: 'sort.discard', node: 1, row: row(0, 2) }],
    }
    expect(stateAt(discard, sortNodes, 9).caption).toBe(
      'Row (0,2) (total 90.00) doesn’t sort before the worst row kept, (0,1) (total 20.00), so it’s dropped.',
    )
  })
})

describe('shortKey', () => {
  it('names a sort key by its column, without the table or the ordering', () => {
    expect(shortKey('orders.total DESC')).toBe('total')
    expect(shortKey('o.order_date DESC NULLS LAST')).toBe('order_date')
    expect(shortKey('(lower(c.email))')).toBe('lower(c.email)')
  })
})

describe('a Nested Loop', () => {
  const CUSTOMERS = 30
  const loopRelations: Trace['relations'] = [...relations, { id: CUSTOMERS, name: 'customers', kind: 'table', pages: 126 }]
  const customer = (block: number, offset: number) => ({ relation: CUSTOMERS, block, offset })
  const joinNodes = new Map<number, NodeInfo>([
    [0, { title: 'Nested Loop', hasFilter: false }],
    [1, { title: 'Seq Scan on customers c', hasFilter: true, parent: 0 }],
    [2, { title: 'Index Scan using orders_pkey on orders o', hasFilter: false, parent: 0 }],
  ])
  /** Two customers from one page; the first has one order, the second none. */
  const join: Trace = {
    relations: loopRelations,
    events: [
      { type: 'node.start', node: 0 },
      { type: 'node.start', node: 1 },
      { type: 'buffer.read', node: 1, page: { relation: CUSTOMERS, block: 5 } },
      { type: 'heap.page', node: 1, page: { relation: CUSTOMERS, block: 5 }, visibleRows: 80, matchedRows: 2 },
      { type: 'row.emit', node: 1, row: customer(5, 3), resultIndex: null },
      { type: 'join.loop', node: 0, loop: 1, outer: [customer(5, 3)], params: [{ name: 'c.id', value: '42' }] },
      { type: 'node.start', node: 2 },
      { type: 'index.search', node: 2, index: INDEX },
      { type: 'buffer.read', node: 2, page: indexPage(57) },
      { type: 'index.visit', node: 2, page: indexPage(57), level: 0, downlink: null },
      { type: 'index.entry', node: 2, page: indexPage(57), offset: 7, key: ['42'], row: row(5, 4) },
      { type: 'buffer.read', node: 2, page: heapPage(5) },
      { type: 'heap.tuple', node: 2, row: row(5, 4), visible: row(5, 4), matched: true },
      { type: 'row.emit', node: 2, row: row(5, 4), resultIndex: null },
      { type: 'row.emit', node: 0, row: row(5, 4), outer: [customer(5, 3)], resultIndex: 0 },
      { type: 'node.finish', node: 2 },
      { type: 'row.emit', node: 1, row: customer(5, 9), resultIndex: null },
      { type: 'join.loop', node: 0, loop: 2, outer: [customer(5, 9)], params: [{ name: 'c.id', value: '43' }] },
      { type: 'node.start', node: 2 },
      { type: 'index.search', node: 2, index: INDEX },
      { type: 'buffer.hit', node: 2, page: indexPage(57) },
      { type: 'index.visit', node: 2, page: indexPage(57), level: 0, downlink: null },
      { type: 'node.finish', node: 2 },
      { type: 'node.finish', node: 1 },
      { type: 'node.finish', node: 0 },
    ],
    indexPages: [],
    sorts: [],
    limits: [],
    heapPages: [],
  }
  const caption = (position: number) => stateAt(join, joinNodes, position).caption

  it('says each loop runs the inner side again with the outer row’s values, and names the tables of a joined row', () => {
    expect(caption(6)).toBe(
      'Loop 1: Nested Loop has row (5,3) from Seq Scan on customers c, so it runs Index Scan using orders_pkey on orders o, with the row’s values: c.id = 42.',
    )
    expect(caption(18)).toBe(
      'Loop 2: Nested Loop has row (5,9) from Seq Scan on customers c, so it runs Index Scan using orders_pkey on orders o again, with the row’s values: c.id = 43.',
    )
    expect(caption(15)).toBe('The joined row customers (5,3) + orders (5,4) goes to the result as row 1.')
    expect(caption(25)).toBe('Nested Loop has no more rows: it sent 1 row to the result.')
  })

  it('works the inner side again in each loop, and counts searches per index', () => {
    expect(stateAt(join, joinNodes, 19).working).toEqual([0, 1, 2])
    expect(stateAt(join, joinNodes, 20).index?.searches).toBe(2)
    expect(nodeProgressAt(join, 25).get(2)).toEqual({ status: 'done', rows: 1 })
  })

  it('marks only the first table’s pages on the mini-map, though the other table has a page 5 too', () => {
    const state = stateAt(join, joinNodes, 25)
    expect(state.table?.name).toBe('customers')
    expect([...state.pageMarks]).toEqual([[5, 'result']])
    const before = stateAt(join, joinNodes, 4)
    expect([...before.pageMarks]).toEqual([[5, 'touched']])
  })

  it('says whether a pair passes the Join Filter', () => {
    const filtered: Trace = {
      ...join,
      events: [
        { type: 'join.filter', node: 0, outer: [customer(5, 3)], row: row(5, 4), matched: true },
        { type: 'join.filter', node: 0, outer: [customer(5, 3)], row: row(5, 6), matched: false },
      ],
    }
    expect(stateAt(filtered, joinNodes, 1).caption).toBe(
      'Nested Loop checks its Join Filter on customers (5,3) with orders (5,4): it passes, so the joined row goes on.',
    )
    expect(stateAt(filtered, joinNodes, 2).caption).toBe(
      'Nested Loop checks its Join Filter on customers (5,3) with orders (5,6): it fails, so the pair is dropped.',
    )
  })
})
