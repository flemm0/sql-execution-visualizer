import type { HeapTupleEvent, PageRef, RowRef, Trace, TraceEvent, TraceRelation } from '../replay/trace'

/*
 * What the visualization shows at a point in the trace: the state after the
 * first `position` events have happened, and a caption for the last one.
 * One step of the player is one trace event (docs/UX.md#playback).
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
}

/** A page this query has asked for, in the order it first asked. */
export interface BufferSlot {
  page: PageRef
  /** Whether it was already in shared buffers when the query first asked for it (a hit) rather than read from disk. */
  wasCached: boolean
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
}

/** What the index zone shows: the current search down the index, and the matches on its leaf. */
export interface IndexView {
  index: TraceRelation
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
  /** How many entries the scan has marked dead so far. */
  markedDead: number
}

/** What happened to a row on the current heap page. */
export type RowOutcome =
  /** Visible, and passed any filter: it goes to the result next. */
  | 'passed'
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
}

/** What the heap zone shows in detail: the page being read now. */
export interface HeapView {
  page: PageRef
  /** For a scan that goes through the whole page: rows visible to the query, and rows that passed the filter. */
  visibleRows: number | null
  matchedRows: number | null
  /** Rows on it the scan has dealt with, the latest last (at most SHOWN_ROWS). */
  rows: HeapRow[]
  /** How many rows on it the scan has dealt with. */
  rowCount: number
}

/** Each heap page's part in the query so far, for the mini-map. */
export type PageMark = 'touched' | 'result'

export interface PlaybackState {
  /** How many events have happened. */
  position: number
  /** The event that happened last; null at the start. */
  current: TraceEvent | null
  /** A sentence about it. */
  caption: string
  /** The node working now; null before it starts and after it finishes. */
  activeNode: number | null
  /** The node that worked last (the active one, or the one that just finished). */
  lastNode: number | null
  hits: number
  reads: number
  /** The pages this query has asked for, in the order it first asked. */
  buffers: BufferSlot[]
  /** Rows sent to the result so far. */
  resultRows: number
  /** The table the query reads (the heap zone). */
  table: TraceRelation | null
  /** Heap pages of that table the query has been through, by block. */
  pageMarks: Map<number, PageMark>
  heap: HeapView | null
  /** Null for a scan that reads no index. */
  index: IndexView | null
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
    hits: 0,
    reads: 0,
    buffers: [],
    resultRows: 0,
    table: scannedTable(trace),
    pageMarks: new Map(),
    heap: null,
    index: null,
  }
  const slots = new Set<string>()
  for (let i = 0; i < end; i++) {
    apply(state, trace.events[i], relations, slots)
  }
  if (state.current !== null) state.caption = describe(state.current, state, relations, nodes)
  return state
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
function apply(state: PlaybackState, event: TraceEvent, relations: Map<number, TraceRelation>, slots: Set<string>) {
  state.current = event
  state.lastNode = event.node

  switch (event.type) {
    case 'node.start':
      state.activeNode = event.node
      break

    case 'node.finish':
      state.activeNode = null
      break

    case 'buffer.hit':
    case 'buffer.read': {
      const hit = event.type === 'buffer.hit'
      if (hit) state.hits++
      else state.reads++
      const key = `${event.page.relation}/${event.page.block}`
      if (!slots.has(key)) {
        slots.add(key)
        state.buffers.push({ page: event.page, wasCached: hit })
      }
      if (relations.get(event.page.relation)?.kind === 'table') {
        enterHeapPage(state, event.page)
        state.pageMarks.set(event.page.block, state.pageMarks.get(event.page.block) ?? 'touched')
      }
      break
    }

    case 'heap.page': {
      const heap = enterHeapPage(state, event.page)
      heap.visibleRows = event.visibleRows
      heap.matchedRows = event.matchedRows
      state.pageMarks.set(event.page.block, state.pageMarks.get(event.page.block) ?? 'touched')
      break
    }

    case 'index.search':
      state.index = {
        index: relations.get(event.index) ?? { id: event.index, name: `index ${event.index}`, kind: 'index', pages: 0 },
        searches: (state.index?.searches ?? 0) + 1,
        path: [],
        leaf: null,
        entries: [],
        entryCount: 0,
        markedDead: state.index?.markedDead ?? 0,
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
      }
      break
    }

    case 'index.entry': {
      const view = state.index
      if (view === null) break
      view.entryCount++
      view.entries = latest(view.entries, { offset: event.offset, key: event.key, row: event.row })
      break
    }

    case 'index.markDead':
      if (state.index) state.index.markedDead += event.offsets.length
      break

    case 'heap.tuple': {
      const heap = enterHeapPage(state, { relation: event.row.relation, block: event.row.block })
      let outcome: RowOutcome
      if (event.visible === null) outcome = 'invisible'
      else outcome = event.matched ? 'passed' : 'rejected'
      heap.rowCount++
      heap.rows = latest(heap.rows, { row: event.row, visible: updatedVersion(event), outcome, resultIndex: null })
      break
    }

    case 'row.emit': {
      const heap = state.heap
      if (heap !== null && heap.page.block === event.row.block && heap.page.relation === event.row.relation) {
        const fetched = lastPassed(heap.rows, event.row)
        if (fetched) {
          fetched.outcome = 'emitted'
          fetched.resultIndex = event.resultIndex
        } else {
          // A scan that goes through the whole page emits rows it didn't list one by one.
          heap.rowCount++
          heap.rows = latest(heap.rows, { row: event.row, visible: null, outcome: 'emitted', resultIndex: event.resultIndex })
        }
      }
      if (event.resultIndex !== null) {
        state.resultRows++
        state.pageMarks.set(event.row.block, 'result')
      }
      break
    }
  }
}

/** The version of a fetched row the query sees, when an UPDATE put a newer one on the same page; null otherwise. */
function updatedVersion(event: HeapTupleEvent): RowRef | null {
  const { row, visible } = event
  if (visible === null || (visible.block === row.block && visible.offset === row.offset)) return null
  return visible
}

/** The latest listed row that passed and is waiting to be emitted as `emitted`. */
function lastPassed(rows: HeapRow[], emitted: RowRef): HeapRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const seen = rows[i].visible ?? rows[i].row
    if (rows[i].outcome === 'passed' && seen.block === emitted.block && seen.offset === emitted.offset) return rows[i]
  }
  return undefined
}

/**
 * A sentence about the event that just happened, from the event and the
 * state after it. Only the step on screen needs one, so stateAt writes just
 * that one.
 */
function describe(
  event: TraceEvent,
  state: PlaybackState,
  relations: Map<number, TraceRelation>,
  nodes: Map<number, NodeInfo>,
): string {
  const node = nodes.get(event.node)
  const title = node?.title ?? `Plan node ${event.node}`

  switch (event.type) {
    case 'node.start':
      return `${title} starts.`

    case 'node.finish':
      return `${title} has no more rows: it sent ${rowCount(state.resultRows)} to the result.`

    case 'buffer.hit':
      return `${capitalize(pageName(event.page, relations))} is already in shared buffers: a hit, no disk read.`

    case 'buffer.read':
      return `${capitalize(pageName(event.page, relations))} isn’t in shared buffers, so it’s read from disk into a buffer.`

    case 'heap.page': {
      const page = capitalize(pageName(event.page, relations))
      const visible = `${rowCount(event.visibleRows)} visible to the query`
      if (!node?.hasFilter) return `${page}: ${visible}; with no filter, every one goes to the result.`
      return `${page}: ${visible}, checked against the filter; ${integer.format(event.matchedRows)} ${event.matchedRows === 1 ? 'passes' : 'pass'}.`
    }

    case 'index.search': {
      const searches = state.index?.searches ?? 1
      const name = state.index?.index.name ?? 'the index'
      return searches === 1
        ? `The scan searches ${name} from its root for the first entry that can match.`
        : `The scan searches ${name} again from the root (search ${integer.format(searches)}), for the next values it needs.`
    }

    case 'index.visit': {
      const path = state.index?.path ?? []
      const previous = path.length >= 2 ? path[path.length - 2] : undefined
      const page = pageName(event.page, relations)
      if (event.level === 0) {
        return previous !== undefined && previous.downlink === null
          ? `More entries could match on the next leaf, so the scan moves right to ${page}.`
          : `The search reaches leaf ${page}, and looks for the first entry that can match.`
      }
      if (event.downlink === null) return `The search moves right to ${page} (level ${event.level}).`
      const where = previous === undefined ? 'the root' : `level ${event.level}`
      return `On ${page} (${where}), the search follows item ${event.downlink} down to the page below.`
    }

    case 'index.entry':
      return `Entry ${formatKey(event.key)} (item ${event.offset}) matches; it points at row ${rowName(event.row)}.`

    case 'index.markDead': {
      const one = event.offsets.length === 1
      const entries = one ? '1 entry' : `${integer.format(event.offsets.length)} entries`
      const them = one ? 'it' : 'them'
      return `No transaction can see the rows of ${entries} on ${pageName(event.page, relations)} any more, so the scan marks ${them} dead; later scans skip ${them}.`
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

    case 'row.emit':
      if (event.resultIndex === null) return `Row ${rowName(event.row)} goes up to the next plan node.`
      return `Row ${rowName(event.row)} goes to the result as row ${integer.format(event.resultIndex + 1)}.`
  }
}

/** Makes `page` the heap zone's page, starting a fresh view when it's another page. */
function enterHeapPage(state: PlaybackState, page: PageRef): HeapView {
  if (state.heap && state.heap.page.relation === page.relation && state.heap.page.block === page.block) return state.heap
  state.heap = { page, visibleRows: null, matchedRows: null, rows: [], rowCount: 0 }
  return state.heap
}

/** The list with `item` added at the end, keeping at most SHOWN_ROWS. */
function latest<T>(items: T[], item: T): T[] {
  return [...items, item].slice(-SHOWN_ROWS)
}

/** "heap page 212" or "index page 57": table and index pages are numbered separately (docs/UX.md). */
export function pageName(page: PageRef, relations: Map<number, TraceRelation>): string {
  const relation = relations.get(page.relation)
  if (relation?.kind === 'index') return `index page ${integer.format(page.block)}`
  return `heap page ${integer.format(page.block)}`
}

/** A buffer slot's short label: "i57" for an index page, "h212" for a heap page. */
export function shortPageName(page: PageRef, relations: Map<number, TraceRelation>): string {
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
