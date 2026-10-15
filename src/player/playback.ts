import {
  passesRowOn,
  type HeapTupleEvent,
  type LimitContents,
  type PageRef,
  type RowRef,
  type SortRow,
  type Trace,
  type TraceEvent,
  type TraceRelation,
} from '../replay/trace'

/*
 * What the visualization shows at a point in the trace: the state after the
 * first `position` events have happened, and a caption for the last one.
 * A player step is one event, or for a long trace, a stretch of several
 * (condense.ts); either way the position here counts events.
 *
 * The state is rebuilt from the start of the trace for every position, which
 * makes stepping back and scrubbing as simple as stepping forward. A trace
 * has one event per page or row, so this is a few thousand events for the
 * examples (ADR 0024).
 */

/** What the captions need to know about a plan node. */
export interface NodeInfo {
  /** Its heading, e.g. "Index Scan using orders_pkey on orders". */
  title: string
  /** Whether it has a Filter, which rows it fetches can fail. */
  hasFilter: boolean
  /** The node it passes its rows up to; absent for the top node, which sends them to the result. */
  parent?: number
}

/** A page this query has asked for, in the order it first asked. */
export interface BufferSlot {
  page: PageRef
  /** Whether it was already in shared buffers when the query first asked for it (a hit) rather than read from disk. */
  wasCached: boolean
  /** Whether a scan asked for it ahead of time and never got to it (a Limit stopped the scan). */
  ahead: boolean
  /** How many times the query has asked for it so far and found it in shared buffers. */
  hits: number
  /** How many times the query has asked for it so far and read it from disk. */
  reads: number
}

/** An index page the current search went through. */
export interface PathStep {
  page: PageRef
  /** 0 for a leaf page, one more for each level above. */
  level: number
  /** The item whose child page the search went down to; null on a leaf, or when it moved right instead. */
  downlink: number | null
}

/** A leaf entry that matched, as the index zone lists it. */
export interface MatchedEntry {
  offset: number
  key: (string | null)[]
  row: RowRef
  /** Whether a bitmap index scan marked its row in the bitmap, rather than a scan fetching it. */
  bitmap: boolean
}

/** What the index zone shows: the current search down the index, and the matches on its leaf. */
export interface IndexView {
  index: TraceRelation
  /** Whether the scan reads the index backward: from high keys to low, moving left along the leaves. */
  backward: boolean
  /** How many searches down from the root have started, this one included. */
  searches: number
  /** The pages this search went through, from the root down, then right along the leaves. */
  path: PathStep[]
  /** The leaf page being read now, if the search has reached one. */
  leaf: PageRef | null
  /** Entries that matched on that leaf, the latest last (at most SHOWN_ROWS). */
  entries: MatchedEntry[]
  /** How many entries matched on that leaf. */
  entryCount: number
  /** The offsets of every entry that matched on that leaf, in order. */
  matchedOffsets: number[]
  /** How many entries the scan has marked dead so far. */
  markedDead: number
  /** The entries it marked dead, as "block/offset". */
  deadEntries: Set<string>
}

/** What happened to a row on the current heap page. */
export type RowOutcome =
  /** Visible, and passed any filter: it goes up next. */
  | 'passed'
  /** Passed up to the plan node above (a Sort or a Limit), not yet to the result. */
  | 'up'
  /** Sent to the result. */
  | 'emitted'
  /** Failed the filter. */
  | 'rejected'
  /** No version of it is visible to the query (deleted, or not committed). */
  | 'invisible'

export interface HeapRow {
  /** The row as the scan reached it (the row an index entry points at). */
  row: RowRef
  /** The version the query can see, when it isn't the row itself (an update kept on the same page). */
  visible: RowRef | null
  outcome: RowOutcome
  /** Which result row it became, counting from 0; null until it's emitted. */
  resultIndex: number | null
  /** For a row passed up, the title of the node it went up to; null otherwise. */
  to: string | null
}

/** What the heap zone shows in detail: the page being read now. */
export interface HeapView {
  page: PageRef
  /** The plan node reading it. */
  node: number
  /** For a scan that goes through the whole page: rows visible to the query, and rows that passed the filter. */
  visibleRows: number | null
  matchedRows: number | null
  /** When a Limit stopped the scan part way through the page, the visible rows it got to; null otherwise. */
  checkedRows: number | null
  /**
   * For an index-only scan, what the visibility map says about the page:
   * all-visible (its rows come from the index alone, and the page isn't
   * read) or not (rows are fetched from it); null for other scans.
   */
  allVisible: boolean | null
  /** For a bitmap heap scan, how many rows the bitmap marks on the page; null for other scans. */
  bitmapRows: number | null
  /** Rows on it the scan has dealt with, the latest last (at most SHOWN_ROWS). */
  rows: HeapRow[]
  /** How many rows on it the scan has dealt with. */
  rowCount: number
}

/**
 * Each heap page's part in the query so far, for the mini-map: read
 * ('touched'), read and gave rows to the result ('result'), all-visible, so
 * an index-only scan didn't read it ('fromIndex'), marked in a bitmap and
 * not read yet ('bitmap'), or read ahead by a scan that a Limit stopped
 * before it got there ('ahead').
 */
export type PageMark = 'touched' | 'result' | 'fromIndex' | 'bitmap' | 'ahead'

/**
 * The bitmap a bitmap index scan builds: for each heap page, the rows on it
 * that matched. Its parent reads those pages afterwards, in physical order.
 */
export interface BitmapView {
  /** The plan node that builds it (the bitmap index scan). */
  node: number
  /** The rows it marks, by heap page: each page's line pointer numbers. */
  pages: Map<number, number[]>
  /** How many rows it marks. */
  rows: number
  /** How many of its pages have been read so far. */
  pagesRead: number
}

/** A row in the Sort zone's list. */
export interface SortListRow {
  row: RowRef
  /** Its sort key's values, as Postgres writes them. */
  key: (string | null)[]
  /** For a row passed on, its place in the sorted order, from 0; null otherwise. */
  position: number | null
  /** Whether the step on screen gave, kept or passed on this row. */
  latest: boolean
}

/** What the Sort zone shows: the rows a Sort holds, then passes on in order. */
export interface SortView {
  node: number
  /** Its sort keys as the plan writes them, e.g. ["orders.total DESC"]. */
  keys: string[]
  /** How it sorts: null while it only collects rows, until it switches to a top-N heapsort or sorts. */
  method: 'quicksort' | 'top-N heapsort' | null
  /** Rows it has been given so far. */
  received: number
  /** Rows it holds now. */
  held: number
  /** In a top-N heapsort, how many rows it keeps; null otherwise. */
  keeps: number | null
  /** Rows a top-N heapsort has dropped. */
  dropped: number
  /** Whether it has sorted its rows, and passes them on. */
  sorted: boolean
  /** Rows passed on so far. */
  passed: number
  /**
   * The rows to list (at most SHOWN_ROWS): while it collects rows, the latest
   * given, the latest last; in a top-N heapsort, the best kept, in sort
   * order, with the worst last; once sorted, the latest passed on.
   */
  rows: SortListRow[]
}

/** What a Limit has done so far. */
export interface LimitView {
  node: number
  /** Its LIMIT; null without one. */
  count: number | null
  /** Its OFFSET; 0 without one. */
  offset: number
  /** Rows skipped for the OFFSET so far. */
  skipped: number
  /** Rows passed on so far. */
  passed: number
  /** Whether it has its LIMIT and stopped. */
  stopped: boolean
}

export interface PlaybackState {
  /** How many events have happened. */
  position: number
  /** The event that happened last; null at the start. */
  current: TraceEvent | null
  /** A sentence about it. */
  caption: string
  /**
   * The node working now: the latest to start and not finish (a parent works
   * again once its child finishes); null before the first starts and after
   * the last finishes.
   */
  activeNode: number | null
  /** The node that worked last (the active one, or the one that just finished). */
  lastNode: number | null
  /** The nodes started and not finished (nor stopped), the latest last: a parent works while its child does. */
  working: number[]
  hits: number
  reads: number
  /** The pages this query has asked for, in the order it first asked. */
  buffers: BufferSlot[]
  /** Rows sent to the result so far. */
  resultRows: number
  /** Rows each plan node has passed on so far, by node id (see passesRowOn). */
  nodeRows: Map<number, number>
  /** The table the query reads (the heap zone). */
  table: TraceRelation | null
  /** Heap pages of that table the query has been through, by block. */
  pageMarks: Map<number, PageMark>
  heap: HeapView | null
  /** Null for a scan that reads no index. */
  index: IndexView | null
  /** Null for a plan without a bitmap scan. */
  bitmap: BitmapView | null
  /** The Sort that worked last; null for a plan without one, or before it starts. */
  sort: SortView | null
  /** The Limit; null for a plan without one, or before it starts. */
  limit: LimitView | null
  /** Nodes a Limit stopped early: they never finish. */
  stopped: Set<number>
}

/**
 * How many rows the first `position` events of the trace send to the result.
 * The results pane shows that many of the real result's rows: row.emit's
 * `resultIndex` counts up from 0, and the validator checks that the replay's
 * rows are the result's, in the same order.
 */
export function resultRowsAt(trace: Trace, position: number): number {
  const end = Math.max(0, Math.min(position, trace.events.length))
  let rows = 0
  for (let i = 0; i < end; i++) {
    const event = trace.events[i]
    if (event.type === 'row.emit' && event.resultIndex !== null) rows++
  }
  return rows
}

/** Where a plan node is at a step: not started, working, finished, or stopped by a Limit before it finished. */
export type NodeStatus = 'waiting' | 'active' | 'done' | 'stopped'

/** A plan node's part in the trace so far, for the plan tree. */
export interface NodeProgress {
  status: NodeStatus
  /**
   * Rows it has passed on so far: to its parent node, or, from the top node,
   * to the result; for a bitmap index scan, rows marked in its bitmap.
   */
  rows: number
}

/**
 * Each plan node's progress after the first `position` events of the trace,
 * by node id. Every node the trace mentions is in it, from 'waiting' before
 * its node.start to 'done' after its node.finish, or 'stopped' when a Limit
 * above it stops.
 */
export function nodeProgressAt(trace: Trace, position: number): Map<number, NodeProgress> {
  const progress = new Map<number, NodeProgress>()
  for (const event of trace.events) {
    if (!progress.has(event.node)) progress.set(event.node, { status: 'waiting', rows: 0 })
  }
  const end = Math.max(0, Math.min(position, trace.events.length))
  for (let i = 0; i < end; i++) {
    const event = trace.events[i]
    const node = progress.get(event.node)
    if (node === undefined) continue
    if (event.type === 'node.start') node.status = 'active'
    else if (event.type === 'node.finish') node.status = 'done'
    else if (passesRowOn(event)) node.rows++
    if (event.type === 'limit.stop') {
      for (const stopped of event.stopped) {
        const below = progress.get(stopped)
        if (below !== undefined) below.status = 'stopped'
      }
    }
  }
  return progress
}

/** How many of the latest rows or entries the zones list. */
export const SHOWN_ROWS = 6

const integer = new Intl.NumberFormat('en-US')

/**
 * The state after the first `position` events of the trace. `nodes` are the
 * plan's nodes by id, for captions.
 */
export function stateAt(trace: Trace, nodes: Map<number, NodeInfo>, position: number): PlaybackState {
  const end = Math.max(0, Math.min(position, trace.events.length))
  const relations = new Map(trace.relations.map((relation) => [relation.id, relation]))
  const state: PlaybackState = {
    position: end,
    current: null,
    caption: startCaption(trace),
    activeNode: null,
    lastNode: null,
    working: [],
    hits: 0,
    reads: 0,
    buffers: [],
    resultRows: 0,
    nodeRows: new Map(),
    table: scannedTable(trace),
    pageMarks: new Map(),
    heap: null,
    index: null,
    bitmap: null,
    sort: null,
    limit: null,
    stopped: new Set(),
  }
  const context: Context = {
    relations,
    nodes,
    slots: new Map(),
    working: [],
    sortRows: new Map(trace.sorts.map((sort) => [sort.node, new Map(sort.rows.map((row) => [rowKey(row.row), row]))])),
    sortKeys: new Map(trace.sorts.map((sort) => [sort.node, sort.keys])),
    limits: new Map(trace.limits.map((limit) => [limit.node, limit])),
    sorts: new Map(),
  }
  for (let i = 0; i < end; i++) {
    apply(state, trace.events[i], context)
  }
  state.working = [...context.working]
  if (state.sort !== null) state.sort.rows = sortList(context.sorts.get(state.sort.node) as SortWork, state.current)
  if (state.current !== null) state.caption = describe(state.current, state, context)
  return state
}

/** What applying events needs besides the state. */
interface Context {
  relations: Map<number, TraceRelation>
  nodes: Map<number, NodeInfo>
  /** The pages in the buffers zone, by "relation/fork/block". */
  slots: Map<string, BufferSlot>
  /** The nodes started and not finished, the latest last. */
  working: number[]
  /** Each Sort's rows, by node, then by rowKey. */
  sortRows: Map<number, Map<string, SortRow>>
  sortKeys: Map<number, string[]>
  limits: Map<number, LimitContents>
  /** Each Sort's rows so far, by node. */
  sorts: Map<number, SortWork>
}

/** A Sort's rows so far, from which its SortView's list is made at the end. */
interface SortWork {
  view: SortView
  /** The latest rows given to it, the latest last. */
  given: SortRow[]
  /** In a top-N heapsort, the rows it keeps, by rowKey. */
  kept: Map<string, SortRow>
  /** The latest rows it passed on, with their places in the sorted order. */
  passed: { row: SortRow; position: number }[]
}

/** The caption before the first step. */
function startCaption(trace: Trace) {
  const steps = trace.events.length
  return `Ready to replay ${integer.format(steps)} ${steps === 1 ? 'step' : 'steps'}. Press play, or step through them one at a time.`
}

/** The table whose pages the trace reads: the first one it asks for, or else its only table. */
function scannedTable(trace: Trace): TraceRelation | null {
  const tables = new Map(trace.relations.filter((relation) => relation.kind === 'table').map((relation) => [relation.id, relation]))
  for (const event of trace.events) {
    if ('page' in event && tables.has(event.page.relation)) return tables.get(event.page.relation) ?? null
    if ('row' in event && tables.has(event.row.relation)) return tables.get(event.row.relation) ?? null
  }
  return tables.size === 1 ? [...tables.values()][0] : null
}

/** Applies one event to the state. */
function apply(state: PlaybackState, event: TraceEvent, context: Context) {
  const { relations, slots, working } = context
  state.current = event
  state.lastNode = event.node
  if (passesRowOn(event)) state.nodeRows.set(event.node, (state.nodeRows.get(event.node) ?? 0) + 1)

  switch (event.type) {
    case 'node.start': {
      working.push(event.node)
      state.activeNode = event.node
      const limit = context.limits.get(event.node)
      if (limit !== undefined) {
        state.limit = { node: event.node, count: limit.count, offset: limit.offset, skipped: 0, passed: 0, stopped: false }
      }
      break
    }

    case 'node.finish':
      working.splice(working.lastIndexOf(event.node), 1)
      state.activeNode = working.at(-1) ?? null
      break

    case 'buffer.hit':
    case 'buffer.read': {
      const hit = event.type === 'buffer.hit'
      if (hit) state.hits++
      else state.reads++
      const key = `${event.page.relation}/${event.page.fork ?? 'main'}/${event.page.block}`
      const slot = slots.get(key)
      if (slot === undefined) {
        const added = { page: event.page, wasCached: hit, ahead: event.ahead === true, hits: hit ? 1 : 0, reads: hit ? 0 : 1 }
        slots.set(key, added)
        state.buffers.push(added)
      } else if (hit) {
        slot.hits++
      } else {
        slot.reads++
      }
      // A page read ahead that the scan never got to: it isn't the page being read now.
      if (event.ahead === true) {
        if (!state.pageMarks.has(event.page.block)) state.pageMarks.set(event.page.block, 'ahead')
        break
      }
      if (relations.get(event.page.relation)?.kind === 'table' && event.page.fork === undefined) {
        const heap = enterHeapPage(state, event.page, event.node)
        markTouched(state, event.page.block)
        // A bitmap heap scan reading the next page its bitmap marks.
        const bitmap = state.bitmap
        const marked = bitmap?.pages.get(event.page.block)
        if (bitmap !== null && marked !== undefined && event.node !== bitmap.node) {
          if (heap.bitmapRows === null) bitmap.pagesRead++
          heap.bitmapRows = marked.length
        }
      }
      break
    }

    case 'heap.page': {
      const heap = enterHeapPage(state, event.page, event.node)
      heap.visibleRows = event.visibleRows
      heap.matchedRows = event.matchedRows
      heap.checkedRows = event.checkedRows ?? null
      markTouched(state, event.page.block)
      break
    }

    case 'index.search':
      state.index = {
        index: relations.get(event.index) ?? { id: event.index, name: `index ${event.index}`, kind: 'index', pages: 0 },
        backward: event.backward === true,
        searches: (state.index?.searches ?? 0) + 1,
        path: [],
        leaf: null,
        entries: [],
        entryCount: 0,
        matchedOffsets: [],
        markedDead: state.index?.markedDead ?? 0,
        deadEntries: state.index?.deadEntries ?? new Set(),
      }
      break

    case 'index.visit': {
      const view = state.index
      if (view === null) break
      view.path.push({ page: event.page, level: event.level, downlink: event.downlink })
      if (event.level === 0) {
        view.leaf = event.page
        view.entries = []
        view.entryCount = 0
        view.matchedOffsets = []
      }
      break
    }

    case 'index.entry': {
      const bitmap = event.bitmap === true
      if (bitmap) markInBitmap(state, event.node, event.row)
      const view = state.index
      if (view === null) break
      view.entryCount++
      // A posting list's entry matches once for each row it points at.
      if (view.matchedOffsets.at(-1) !== event.offset) view.matchedOffsets.push(event.offset)
      view.entries = latest(view.entries, { offset: event.offset, key: event.key, row: event.row, bitmap })
      break
    }

    case 'index.markDead':
      if (state.index) {
        state.index.markedDead += event.offsets.length
        for (const offset of event.offsets) state.index.deadEntries.add(`${event.page.block}/${offset}`)
      }
      break

    case 'heap.tuple': {
      const heap = enterHeapPage(state, { relation: event.row.relation, block: event.row.block }, event.node)
      let outcome: RowOutcome
      if (event.visible === null) outcome = 'invisible'
      else outcome = event.matched ? 'passed' : 'rejected'
      heap.rowCount++
      heap.rows = latest(heap.rows, { row: event.row, visible: updatedVersion(event), outcome, resultIndex: null, to: null })
      break
    }

    case 'visibility.check': {
      const heap = enterHeapPage(state, event.page, event.node)
      heap.allVisible = event.allVisible
      if (event.allVisible) {
        state.pageMarks.set(event.page.block, 'fromIndex')
        if (event.matched === false) {
          heap.rowCount++
          heap.rows = latest(heap.rows, { row: event.row, visible: null, outcome: 'rejected', resultIndex: null, to: null })
        }
      }
      break
    }

    case 'row.emit': {
      // A row going up to a Sort, which holds it; or one a Sort passes on, in order.
      const parent = context.nodes.get(event.node)?.parent
      const into = parent === undefined ? undefined : sortWork(state, context, parent)
      if (into !== undefined) {
        const row = context.sortRows.get(into.view.node)?.get(rowKey(event.row))
        into.view.received++
        if (into.view.method === null) into.view.held++
        if (row !== undefined) into.given = latest(into.given, row)
      }
      const from = context.sorts.get(event.node)
      if (from !== undefined) {
        state.sort = from.view
        const row = context.sortRows.get(event.node)?.get(rowKey(event.row))
        if (row !== undefined) from.passed = latest(from.passed, { row, position: from.view.passed })
        from.view.passed++
      }
      if (state.limit?.node === event.node) state.limit.passed++
      const heap = state.heap
      if (heap !== null && heap.page.block === event.row.block && heap.page.relation === event.row.relation) {
        const outcome = event.resultIndex === null ? 'up' : 'emitted'
        const to = event.resultIndex === null && parent !== undefined ? (context.nodes.get(parent)?.title ?? null) : null
        if (event.node === heap.node) {
          const fetched = lastWith(heap.rows, event.row, 'passed')
          if (fetched) {
            fetched.outcome = outcome
            fetched.resultIndex = event.resultIndex
            fetched.to = to
          } else {
            // A scan that goes through the whole page passes up rows it didn't list one by one.
            heap.rowCount++
            heap.rows = latest(heap.rows, { row: event.row, visible: null, outcome, resultIndex: event.resultIndex, to })
          }
        } else if (event.resultIndex !== null) {
          // A Limit above the scan sends the row on to the result.
          const up = lastWith(heap.rows, event.row, 'up')
          if (up) {
            up.outcome = 'emitted'
            up.resultIndex = event.resultIndex
            up.to = null
          }
        }
      }
      if (event.resultIndex !== null) {
        state.resultRows++
        // A page the scan didn't read keeps its mark.
        if (state.pageMarks.get(event.row.block) !== 'fromIndex') state.pageMarks.set(event.row.block, 'result')
      }
      break
    }

    case 'sort.heap': {
      const work = sortWork(state, context, event.node) as SortWork
      work.view.method = 'top-N heapsort'
      work.view.keeps = event.kept.length
      work.view.held = event.kept.length
      work.view.dropped += event.dropped.length
      const rows = context.sortRows.get(event.node)
      for (const kept of event.kept) {
        const row = rows?.get(rowKey(kept))
        if (row !== undefined) work.kept.set(rowKey(kept), row)
      }
      break
    }

    case 'sort.keep': {
      const work = sortWork(state, context, event.node) as SortWork
      work.kept.delete(rowKey(event.replaced))
      const row = context.sortRows.get(event.node)?.get(rowKey(event.row))
      if (row !== undefined) work.kept.set(rowKey(event.row), row)
      work.view.dropped++
      break
    }

    case 'sort.discard':
      ;(sortWork(state, context, event.node) as SortWork).view.dropped++
      break

    case 'sort.done': {
      const view = (sortWork(state, context, event.node) as SortWork).view
      view.method = event.method
      view.held = event.rows
      view.sorted = true
      break
    }

    case 'limit.skip':
      if (state.limit?.node === event.node) state.limit.skipped++
      break

    case 'limit.stop':
      if (state.limit?.node === event.node) state.limit.stopped = true
      // The nodes below it stop where they are: they're no longer working.
      for (const node of event.stopped) {
        state.stopped.add(node)
        const at = working.lastIndexOf(node)
        if (at >= 0) working.splice(at, 1)
      }
      state.activeNode = working.at(-1) ?? null
      break
  }
}

/** The Sort node `node`'s work so far, made the Sort zone's; undefined if `node` isn't a Sort. */
function sortWork(state: PlaybackState, context: Context, node: number): SortWork | undefined {
  const keys = context.sortKeys.get(node)
  if (keys === undefined) return undefined
  let work = context.sorts.get(node)
  if (work === undefined) {
    const view: SortView = { node, keys, method: null, received: 0, held: 0, keeps: null, dropped: 0, sorted: false, passed: 0, rows: [] }
    work = { view, given: [], kept: new Map(), passed: [] }
    context.sorts.set(node, work)
  }
  state.sort = work.view
  return work
}

/** The Sort zone's list (see SortView.rows), for the step on screen, `current`. */
function sortList(work: SortWork, current: TraceEvent | null): SortListRow[] {
  const isCurrent = (row: RowRef) =>
    current !== null && 'row' in current && current.row.block === row.block && current.row.offset === row.offset
  if (work.view.sorted) {
    return work.passed.map(({ row, position }) => ({ row: row.row, key: row.key, position, latest: isCurrent(row.row) }))
  }
  if (work.view.method === 'top-N heapsort') {
    const kept = [...work.kept.values()].sort((a, b) => a.rank - b.rank)
    // The best ones, and the worst: the one a new row has to beat.
    const shown = kept.length <= SHOWN_ROWS ? kept : [...kept.slice(0, SHOWN_ROWS - 1), kept[kept.length - 1]]
    return shown.map((row) => ({ row: row.row, key: row.key, position: null, latest: isCurrent(row.row) }))
  }
  return work.given.map((row) => ({ row: row.row, key: row.key, position: null, latest: isCurrent(row.row) }))
}

function rowKey(row: RowRef) {
  return `${row.relation}/${row.block}/${row.offset}`
}

/** Marks a heap page as read, unless it already says more (it gave rows to the result, or the visibility map spared it). */
function markTouched(state: PlaybackState, block: number) {
  const mark = state.pageMarks.get(block)
  if (mark === undefined || mark === 'bitmap') state.pageMarks.set(block, 'touched')
}

/** Adds a row to the bitmap `node` builds, and marks its page on the mini-map. */
function markInBitmap(state: PlaybackState, node: number, row: RowRef) {
  state.bitmap ??= { node, pages: new Map(), rows: 0, pagesRead: 0 }
  const offsets = state.bitmap.pages.get(row.block) ?? []
  if (!offsets.includes(row.offset)) {
    state.bitmap.pages.set(row.block, [...offsets, row.offset])
    state.bitmap.rows++
  }
  if (!state.pageMarks.has(row.block)) state.pageMarks.set(row.block, 'bitmap')
}

/** The version of a fetched row the query sees, when an UPDATE put a newer one on the same page; null otherwise. */
function updatedVersion(event: HeapTupleEvent): RowRef | null {
  const { row, visible } = event
  if (visible === null || (visible.block === row.block && visible.offset === row.offset)) return null
  return visible
}

/** The latest listed row with this outcome whose version the query sees is `emitted`. */
function lastWith(rows: HeapRow[], emitted: RowRef, outcome: RowOutcome): HeapRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const seen = rows[i].visible ?? rows[i].row
    if (rows[i].outcome === outcome && seen.block === emitted.block && seen.offset === emitted.offset) return rows[i]
  }
  return undefined
}

/**
 * A sentence about the event that just happened, from the event and the
 * state after it. Only the step on screen needs one, so stateAt writes just
 * that one.
 */
function describe(event: TraceEvent, state: PlaybackState, context: Context): string {
  const { relations, nodes } = context
  const node = nodes.get(event.node)
  const title = node?.title ?? `Plan node ${event.node}`
  /** Where the node's rows go: the result, or the node above. */
  const parentTitle = node?.parent === undefined ? null : (nodes.get(node.parent)?.title ?? `plan node ${node.parent}`)
  const goesUp = parentTitle === null ? 'goes to the result' : `goes up to ${parentTitle}`

  switch (event.type) {
    case 'node.start':
      return `${title} starts.`

    case 'node.finish': {
      if (state.activeNode === null) return `${title} has no more rows: it sent ${rowCount(state.resultRows)} to the result.`
      // The node working again is the parent this one passed its rows, or its bitmap, up to.
      const parent = nodes.get(state.activeNode)?.title ?? `plan node ${state.activeNode}`
      const bitmap = state.bitmap
      if (bitmap !== null && bitmap.node === event.node) {
        const pages = bitmap.pages.size
        return `${title} is done: its bitmap marks ${rowCount(bitmap.rows)} on ${integer.format(pages)} heap ${pages === 1 ? 'page' : 'pages'}. ${parent} reads those pages next, in physical order, each one once.`
      }
      return `${title} has no more rows: it passed ${rowCount(state.nodeRows.get(event.node) ?? 0)} up to ${parent}.`
    }

    case 'buffer.hit':
    case 'buffer.read': {
      const page = capitalize(pageName(event.page, relations))
      if (event.ahead === true) {
        const asked =
          event.type === 'buffer.read'
            ? 'had been read from disk into a buffer ahead of the scan'
            : 'had been pinned ahead of the scan (it was already in shared buffers: a hit)'
        return `${page} ${asked}, but the scan stopped before it got there. Postgres reads the pages a scan will need next in batches, and counts them all.`
      }
      const access =
        event.type === 'buffer.hit'
          ? 'is already in shared buffers: a hit, no disk read.'
          : 'isn’t in shared buffers, so it’s read from disk into a buffer.'
      const bitmap = state.bitmap
      const heap = state.heap
      const reading =
        bitmap !== null && event.node !== bitmap.node && heap !== null && heap.bitmapRows !== null && samePage(heap.page, event.page)
      if (!reading) return `${page} ${access}`
      const marked = heap.bitmapRows ?? 0
      const where = `${page}, page ${integer.format(bitmap.pagesRead)} of ${integer.format(bitmap.pages.size)} in the bitmap, has ${rowCount(marked)} marked.`
      return `${where} It ${access}`
    }

    case 'heap.page': {
      const page = capitalize(pageName(event.page, relations))
      const visible = `${rowCount(event.visibleRows)} visible to the query`
      if (event.checkedRows !== undefined) {
        const checked = node?.hasFilter ? 'checks the filter on' : 'goes through'
        const which = event.checkedRows === 1 ? 'the first' : `the first ${integer.format(event.checkedRows)}`
        return `${page}: ${visible}. The scan ${checked} ${which} only: with ${rowCount(event.matchedRows)} from it, ${parentTitle ?? 'the node above'} has all it needs.`
      }
      if (!node?.hasFilter) return `${page}: ${visible}; with no filter, every one ${goesUp}.`
      return `${page}: ${visible}, checked against the filter; ${integer.format(event.matchedRows)} ${event.matchedRows === 1 ? 'passes' : 'pass'}.`
    }

    case 'index.search': {
      const searches = state.index?.searches ?? 1
      const name = state.index?.index.name ?? 'the index'
      if (event.backward === true) {
        return `The scan reads ${name} backward, from high keys to low: it searches from the root for the last entry that can match.`
      }
      return searches === 1
        ? `The scan searches ${name} from its root for the first entry that can match.`
        : `The scan searches ${name} again from the root (search ${integer.format(searches)}), for the next values it needs.`
    }

    case 'index.visit': {
      const path = state.index?.path ?? []
      const previous = path.length >= 2 ? path[path.length - 2] : undefined
      const page = pageName(event.page, relations)
      if (event.level === 0) {
        const backward = state.index?.backward === true
        if (previous !== undefined && previous.downlink === null) {
          return `More entries could match on the next leaf, so the scan moves ${backward ? 'left' : 'right'} to ${page}.`
        }
        return `The search reaches leaf ${page}, and looks for the ${backward ? 'last' : 'first'} entry that can match.`
      }
      if (event.downlink === null) return `The search moves right to ${page} (level ${event.level}).`
      const where = previous === undefined ? 'the root' : `level ${event.level}`
      return `On ${page} (${where}), the search follows item ${event.downlink} down to the page below.`
    }

    case 'index.entry': {
      const entry = `Entry ${formatKey(event.key)} (item ${event.offset}) matches`
      if (event.bitmap !== true) return `${entry}; it points at row ${rowName(event.row)}.`
      const marked = state.bitmap?.pages.get(event.row.block)?.length ?? 1
      const page = pageName({ relation: event.row.relation, block: event.row.block }, relations)
      return `${entry}; the scan marks its row, ${rowName(event.row)}, in the bitmap instead of fetching it (${page}: ${rowCount(marked)} marked).`
    }

    case 'index.markDead': {
      const one = event.offsets.length === 1
      const entries = one ? '1 entry' : `${integer.format(event.offsets.length)} entries`
      const them = one ? 'it' : 'them'
      const marks = `No transaction can see the rows of ${entries} on ${pageName(event.page, relations)} any more, so the scan marks ${them} dead; later scans skip ${them}.`
      // A scan a Limit stopped does it as the query ends.
      return state.stopped.has(event.node) ? `As the query ends: ${marks.charAt(0).toLowerCase()}${marks.slice(1)}` : marks
    }

    case 'heap.tuple': {
      const row = `Row ${rowName(event.row)}`
      if (event.visible === null) return `${row} isn’t visible to this query (deleted, or not yet committed), so it’s skipped.`
      // An UPDATE that kept the row on its page: the index entry still points at the old version.
      const newer = updatedVersion(event)
      const seen = newer
        ? `${row} was updated on the same page; this query sees the newer version, ${rowName(newer)}`
        : `${row} is visible to this query`
      if (!node?.hasFilter) return `${seen}.`
      if (event.matched) return `${seen}, and it passes the filter.`
      return `${seen}, but it fails the filter, so it’s rejected.`
    }

    case 'visibility.check': {
      const page = pageName(event.page, relations)
      const row = rowName(event.row)
      if (!event.allVisible) {
        return `The visibility map doesn’t mark ${page} all-visible, so the scan fetches row ${row} from the heap to check this query can see it.`
      }
      const skip = `The visibility map marks ${page} all-visible (every row on it is visible to every transaction), so the entry’s values are enough: row ${row} isn’t fetched from the heap`
      if (!node?.hasFilter) return `${skip}.`
      return event.matched ? `${skip}, and they pass the filter.` : `${skip}. Its values fail the filter, so it’s rejected.`
    }

    case 'row.emit': {
      const sort = context.sorts.get(event.node)
      // A Sort passes its rows on in sorted order.
      const row = sort === undefined ? `Row ${rowName(event.row)}` : `Row ${rowName(event.row)}, ${ordinal(sort.view.passed - 1)} in sort order,`
      if (event.resultIndex !== null) {
        const limit = state.limit?.node === event.node ? state.limit : null
        const of = limit?.count != null ? ` (${integer.format(limit.passed)} of the Limit’s ${integer.format(limit.count)})` : ''
        return `${row} goes to the result as row ${integer.format(event.resultIndex + 1)}${of}.`
      }
      const into = node?.parent === undefined ? undefined : context.sorts.get(node.parent)
      if (into !== undefined && into.view.method === null) {
        return `${row} ${goesUp}, which holds it in memory with the others to sort them (${rowCount(into.view.held)} so far).`
      }
      return `${row} ${goesUp}.`
    }

    case 'sort.heap': {
      const keeps = event.kept.length
      return `${title} holds ${rowCount(keeps + event.dropped.length)}, more than twice the ${integer.format(keeps)} the Limit above needs, so it switches to a top-N heapsort: it keeps the best ${integer.format(keeps)}, with the worst of them on top to compare new rows with, and drops the other ${integer.format(event.dropped.length)}.`
    }

    case 'sort.keep': {
      const replaced = context.sortRows.get(event.node)?.get(rowKey(event.replaced))
      return `Row ${rowName(event.row)}${keyText(context, event.node, event.row)} sorts before the worst row kept, ${rowName(event.replaced)}${replaced ? keyText(context, event.node, event.replaced) : ''}, so it takes its place, and ${rowName(event.replaced)} is dropped.`
    }

    case 'sort.discard': {
      const worst = worstKept(context, event.node)
      const than = worst === null ? 'the worst row kept' : `the worst row kept, ${rowName(worst.row)}${keyText(context, event.node, worst.row)}`
      return `Row ${rowName(event.row)}${keyText(context, event.node, event.row)} doesn’t sort before ${than}, so it’s dropped.`
    }

    case 'sort.done': {
      const by = `by ${(context.sortKeys.get(event.node) ?? []).join(', ')}`
      const passes = parentTitle === null ? 'sends them to the result in that order' : `passes them up to ${parentTitle} in that order`
      if (event.method === 'quicksort') {
        return `${title} has all ${rowCount(event.rows)} from below: it sorts them in memory ${by} (a quicksort), then ${passes}.`
      }
      const seen = state.sort?.received ?? event.rows
      return `${title} has seen all ${rowCount(seen)} from below and kept the best ${integer.format(event.rows)}: it sorts those ${by}, then ${passes}.`
    }

    case 'limit.skip': {
      const limit = state.limit
      const skipped = limit === null ? '' : ` (${integer.format(limit.skipped)} of ${integer.format(limit.offset)} skipped)`
      return `${title} skips row ${rowName(event.row)}, for its OFFSET${skipped}.`
    }

    case 'limit.stop': {
      const count = state.limit?.node === event.node ? (state.limit.count ?? 0) : 0
      if (count === 0) return `${title} needs no rows (LIMIT 0), so it never asks the node below it for one.`
      const names = event.stopped.map((stopped) => nodes.get(stopped)?.title ?? `plan node ${stopped}`)
      const passed = `${title} has passed on its ${rowCount(count)} (LIMIT ${integer.format(count)}), so it stops`
      if (names.length === 0) return `${passed}.`
      const which = names.length === 1 ? 'which stops where it is' : `and ${names.join(' and ')} stop where they are`
      return `${passed}: it doesn’t ask ${names[0]} for another row, ${which}.`
    }
  }
}

/** " (total 512.00)": a row's sort key, as the Sort zone writes it; empty if unknown. */
function keyText(context: Context, sort: number, row: RowRef): string {
  const found = context.sortRows.get(sort)?.get(rowKey(row))
  if (found === undefined) return ''
  const keys = context.sortKeys.get(sort) ?? []
  return ` (${found.key.map((value, i) => `${shortKey(keys[i] ?? '')} ${value ?? 'NULL'}`).join(', ')})`
}

/** A top-N heapsort's worst row kept now: the one a new row has to beat. */
function worstKept(context: Context, sort: number): SortRow | null {
  const kept = [...(context.sorts.get(sort)?.kept.values() ?? [])]
  return kept.reduce<SortRow | null>((worst, row) => (worst === null || row.rank > worst.rank ? row : worst), null)
}

/** A sort key's name for captions: its expression without the table, ordering and parentheses, e.g. "total". */
export function shortKey(key: string): string {
  const expression = key.replace(/ NULLS (FIRST|LAST)$/, '').replace(/ DESC$/, '').replace(/ USING \S+$/, '')
  return expression.replace(/^\((.*)\)$/, '$1').replace(/^[\w"]+\./, '')
}

/** "1st", "2nd", "3rd", "4th", … for a place counted from 0. */
function ordinal(position: number): string {
  const n = position + 1
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${integer.format(n)}${suffix}`
}

/** Makes `page` the heap zone's page, starting a fresh view when it's another page. */
function enterHeapPage(state: PlaybackState, page: PageRef, node: number): HeapView {
  if (state.heap && state.heap.page.relation === page.relation && state.heap.page.block === page.block) return state.heap
  state.heap = { page, node, visibleRows: null, matchedRows: null, checkedRows: null, allVisible: null, bitmapRows: null, rows: [], rowCount: 0 }
  return state.heap
}

function samePage(a: PageRef, b: PageRef) {
  return a.relation === b.relation && a.block === b.block && a.fork === b.fork
}

/** The list with `item` added at the end, keeping at most SHOWN_ROWS. */
function latest<T>(items: T[], item: T): T[] {
  return [...items, item].slice(-SHOWN_ROWS)
}

/**
 * "heap page 212", "index page 57" or "visibility map page 0": table and
 * index pages, and a table's visibility map, are numbered separately (docs/UX.md).
 */
export function pageName(page: PageRef, relations: Map<number, TraceRelation>): string {
  if (page.fork === 'vm') return `visibility map page ${integer.format(page.block)}`
  const relation = relations.get(page.relation)
  if (relation?.kind === 'index') return `index page ${integer.format(page.block)}`
  return `heap page ${integer.format(page.block)}`
}

/** A buffer slot's short label: "i57" for an index page, "h212" for a heap page, "vm0" for a visibility map page. */
export function shortPageName(page: PageRef, relations: Map<number, TraceRelation>): string {
  if (page.fork === 'vm') return `vm${page.block}`
  return `${relations.get(page.relation)?.kind === 'index' ? 'i' : 'h'}${page.block}`
}

/** A row's place as Postgres writes a ctid: "(212,4)". */
export function rowName(row: { block: number; offset: number }): string {
  return `(${row.block},${row.offset})`
}

/** An index key: "42", or "(42, 3)" for several columns; NULL as NULL. */
export function formatKey(key: (string | null)[]): string {
  const values = key.map((value) => value ?? 'NULL')
  return values.length === 1 ? values[0] : `(${values.join(', ')})`
}

function rowCount(count: number) {
  return `${integer.format(count)} ${count === 1 ? 'row' : 'rows'}`
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * A key as the page box writes it: "4242", or "(777, 2)" for several
 * columns. A downlink keeps only the columns it needs; the ones it dropped,
 * and the first downlink's whole key, stand for minus infinity (−∞).
 */
export function formatIndexKey(key: (string | null)[], keyColumns: number): string {
  if (key.length === 0) return '−∞'
  const values = key.map((value) => value ?? 'NULL')
  while (values.length < keyColumns) values.push('−∞')
  return values.length === 1 ? values[0] : `(${values.join(', ')})`
}

/** Steps per second, or 'instant' to jump straight to the end. */
export type Speed = number | 'instant'

/**
 * Where a newly loaded trace starts: with autoplay on, playing from step 0
 * (at instant speed, already at its end); with autoplay off, paused at step 0,
 * whatever the speed.
 */
export function startOfTrace(steps: number, speed: Speed, autoplay: boolean): { position: number; playing: boolean } {
  if (!autoplay) return { position: 0, playing: false }
  return { position: speed === 'instant' ? steps : 0, playing: true }
}
