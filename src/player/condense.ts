import type { PageRef, Trace, TraceEvent } from '../replay/trace'
import { pageName, type NodeInfo } from './playback'

/*
 * Condensing: the player's steps over a trace (docs/UX.md#playback, ADR 0041).
 *
 * The trace stays as the replay made it, one event per action. The player
 * plays a list of steps over it: each step is a range of consecutive events.
 * A step of one event is played as before; a step of several is a
 * **stretch**, a repetitive run of real events shown as one step with a
 * summary counted from those events. Steps cover every event exactly once,
 * in order, so the state after a step is stateAt(trace, nodes, step.end) and
 * nothing is invented or dropped.
 *
 * A trace short enough to play in the budget isn't condensed at all. A longer
 * one is cut into units (one page or one row of work, see buildUnits), and
 * runs of units are grouped into stretches of at most `size` units, the
 * smallest size that fits the budget.
 */

/** A step of the player: the events from `start` up to (not including) `end`. */
export interface Step {
  start: number
  end: number
  /** For a step of an expanded stretch (one event each), the stretch it came from, to collapse it again. */
  stretch?: { start: number; end: number }
}

/** At the default 30 steps a second, about 30 seconds (ADR 0005). */
export const STEP_BUDGET = 900

/**
 * At the start of each phase (a node starts or finishes, a Sort passes its
 * rows on), units play event by event until this many events have: the first
 * pages or rows of a scan show every step before stretches begin.
 */
export const EARLY_EVENTS = 12

/** Whether a step groups several events: a stretch, shown as one step with a summary. */
export function isStretch(step: Step): boolean {
  return step.end - step.start > 1
}

/** How many events have happened after the first `position` steps. */
export function eventsDone(steps: Step[], position: number): number {
  if (position <= 0 || steps.length === 0) return 0
  return steps[Math.min(position, steps.length) - 1].end
}

/** One step per event, for events start to end. */
function eachEvent(start: number, end: number, stretch?: { start: number; end: number }): Step[] {
  const steps: Step[] = []
  for (let i = start; i < end; i++) steps.push(stretch === undefined ? { start: i, end: i + 1 } : { start: i, end: i + 1, stretch })
  return steps
}

/** The steps to play a trace in about `budget` steps: one per event if it fits, otherwise with stretches. */
export function condense(trace: Trace, budget: number = STEP_BUDGET): Step[] {
  const events = trace.events
  if (events.length <= budget) return eachEvent(0, events.length)
  // Rows sent to the result flash one by one if the budget allows; otherwise stretches carry them too.
  for (const flash of [true, false]) {
    const units = buildUnits(events, flash)
    const size = smallestSize(units, budget, EARLY_EVENTS)
    if (size !== null) return layout(units, size, EARLY_EVENTS)
  }
  // Without the first units in full, then; failing that, the fewest steps there are (a plan with very many searches, say).
  const units = buildUnits(events, false)
  return layout(units, smallestSize(units, budget, 0) ?? units.length, 0)
}

/**
 * A unit: one page or one row of a scan's work, the smallest piece a stretch
 * holds. Events start a new unit unless they carry on the one before (see
 * carriesOn): a Seq Scan's page is its buffer access, the page and the rows
 * it sends on; an index scan's row is its entry, the heap page access, the
 * fetch and the row passed on.
 */
interface Unit {
  start: number
  end: number
  /** Never part of a stretch: a node starting or finishing, a search down the index, an index page, a Sort's or Limit's turning points. */
  fixed: boolean
  /** Played on its own, event by event: a row sent to the result, or one a top-N heapsort keeps (when rows flash). */
  flash: boolean
  /** Starts a phase of the plan (a node starts or finishes, a Sort has sorted), after which the first units play in full again. */
  phase: boolean
}

/** Events a stretch never holds. */
const FIXED = new Set<TraceEvent['type']>([
  'node.start',
  'node.finish',
  'index.search',
  'index.visit',
  'index.markDead',
  'sort.heap',
  'sort.done',
  'limit.stop',
])

const PHASES = new Set<TraceEvent['type']>(['node.start', 'node.finish', 'sort.done'])

/** What buildUnits needs to know about the unit it's building. */
interface Building extends Unit {
  head: TraceEvent
  last: TraceEvent
  hasTuple: boolean
  hasCheck: boolean
  /** Nodes that have passed a row on in this unit. */
  emitted: Set<number>
  /** Heap pages a scan in this unit went through whole, as "node/relation/block". */
  scanned: Set<string>
}

/** Cuts the events into units. With `flash`, rows sent to the result (and rows a top-N heapsort keeps) are units of their own. */
function buildUnits(events: TraceEvent[], flash: boolean): Unit[] {
  const units: Unit[] = []
  let unit: Building | null = null
  events.forEach((event, i) => {
    if (unit !== null && carriesOn(unit, event, flash)) {
      unit.end = i + 1
      unit.last = event
      if (FIXED.has(event.type)) unit.fixed = true
    } else {
      if (unit !== null) units.push(plain(unit))
      unit = {
        start: i,
        end: i + 1,
        fixed: FIXED.has(event.type),
        flash: flash && isFlash(event),
        phase: PHASES.has(event.type),
        head: event,
        last: event,
        hasTuple: false,
        hasCheck: false,
        emitted: new Set(),
        scanned: new Set(),
      }
    }
    if (event.type === 'heap.tuple') unit.hasTuple = true
    if (event.type === 'visibility.check') unit.hasCheck = true
    if (event.type === 'row.emit') unit.emitted.add(event.node)
    if (event.type === 'heap.page') unit.scanned.add(`${event.node}/${event.page.relation}/${event.page.block}`)
  })
  if (unit !== null) units.push(plain(unit))
  return units
}

function plain(unit: Building): Unit {
  return { start: unit.start, end: unit.end, fixed: unit.fixed, flash: unit.flash, phase: unit.phase }
}

/** A row sent to the result, or one a top-N heapsort keeps: the moments that flash on their own. */
function isFlash(event: TraceEvent): boolean {
  return (event.type === 'row.emit' && event.resultIndex !== null) || event.type === 'sort.keep'
}

/** Whether `event` belongs to the unit before it. */
function carriesOn(unit: Building, event: TraceEvent, flash: boolean): boolean {
  if (unit.fixed || unit.flash) return false
  const { head, last } = unit
  switch (event.type) {
    // An index page, or a page a Seq Scan goes through, right after its buffer access.
    case 'index.visit':
    case 'heap.page':
      return isBufferAccess(last) && last.node === event.node && samePage(last.page, event.page)
    // An index scan's access to the heap page (or visibility map page) for the entry it matched.
    case 'buffer.hit':
    case 'buffer.read':
      return (
        event.ahead !== true &&
        head.type === 'index.entry' &&
        head.bitmap !== true &&
        head.node === event.node &&
        !unit.hasTuple &&
        unit.emitted.size === 0
      )
    case 'visibility.check':
      return head.type === 'index.entry' && head.node === event.node && !unit.hasCheck
    // Fetching the row an entry points at, or the first row a bitmap marks on the page just read.
    case 'heap.tuple':
      if (unit.hasTuple || head.node !== event.node) return false
      if (head.type === 'index.entry') return true
      return isBufferAccess(head) && head.page.relation === event.row.relation && head.page.block === event.row.block
    case 'row.emit':
      if (flash && event.resultIndex !== null) return false
      // A Seq Scan sends on every matching row of the page it went through; otherwise one row per node.
      return unit.scanned.has(`${event.node}/${event.row.relation}/${event.row.block}`) || !unit.emitted.has(event.node)
    case 'sort.keep':
      return !flash && last.type === 'row.emit'
    case 'sort.discard':
    case 'limit.skip':
      return last.type === 'row.emit'
    default:
      return false
  }
}

function isBufferAccess(event: TraceEvent): event is Extract<TraceEvent, { type: 'buffer.hit' | 'buffer.read' }> {
  return event.type === 'buffer.hit' || event.type === 'buffer.read'
}

function samePage(a: PageRef, b: PageRef) {
  return a.relation === b.relation && a.block === b.block && a.fork === b.fork
}

/**
 * The steps for units: fixed and flashing units, and the units that start in
 * the first `early` events of each phase, one event at a time; the rest in
 * stretches of at most `size` units.
 */
function layout(units: Unit[], size: number, early: number): Step[] {
  const steps: Step[] = []
  let stretch: Step | null = null
  let inStretch = 0
  let sincePhase = 0
  for (const unit of units) {
    if (unit.fixed || unit.flash || sincePhase < early) {
      if (stretch !== null) steps.push(stretch)
      stretch = null
      steps.push(...eachEvent(unit.start, unit.end))
      if (unit.phase) sincePhase = 0
      else sincePhase += unit.end - unit.start
      continue
    }
    if (stretch === null) {
      stretch = { start: unit.start, end: unit.end }
      inStretch = 1
    } else {
      stretch.end = unit.end
      inStretch++
    }
    if (inStretch >= size) {
      steps.push(stretch)
      stretch = null
    }
  }
  if (stretch !== null) steps.push(stretch)
  return steps
}

/**
 * The smallest stretch size (in units) whose steps fit the budget, or null if
 * none does. Bigger stretches never make more steps, so a binary search finds it.
 */
function smallestSize(units: Unit[], budget: number, early: number): number | null {
  if (layout(units, units.length, early).length > budget) return null
  let low = 1
  let high = units.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (layout(units, middle, early).length <= budget) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * Expands the stretch at `index`: one step per event, each remembering the
 * stretch, so it can be collapsed again. The step's events were in the trace
 * all along; only these steps are made now.
 */
export function expandStretch(steps: Step[], index: number): Step[] {
  const step = steps[index]
  if (step === undefined || !isStretch(step)) return steps
  const stretch = { start: step.start, end: step.end }
  return [...steps.slice(0, index), ...eachEvent(step.start, step.end, stretch), ...steps.slice(index + 1)]
}

/**
 * Collapses the expanded stretch the step at `index` belongs to back into one
 * step. Returns the steps and where that one step is.
 */
export function collapseStretch(steps: Step[], index: number): { steps: Step[]; index: number } {
  const stretch = steps[index]?.stretch
  if (stretch === undefined) return { steps, index }
  let first = index
  while (first > 0 && steps[first - 1].stretch?.start === stretch.start) first--
  let last = index
  while (last < steps.length - 1 && steps[last + 1].stretch?.start === stretch.start) last++
  return { steps: [...steps.slice(0, first), { start: stretch.start, end: stretch.end }, ...steps.slice(last + 1)], index: first }
}

/** What a stretch's events did, counted from them. */
export interface StretchSummary {
  /** How many events it groups. */
  events: number
  hits: number
  reads: number
  /** Pages asked for ahead of a scan that a Limit stopped. */
  ahead: number
  /** Heap pages a scan went through whole (heap.page), in order. */
  scannedPages: number[]
  /** Rows on those pages visible to the query (of those checked, on a page a Limit stopped the scan on), and how many passed the filter. */
  rowsChecked: number
  rowsMatched: number
  /** Index entries that matched, and the leaf pages they're on, in order. */
  entries: number
  /** Of those, the ones a bitmap index scan marked in its bitmap. */
  marked: number
  leafPages: number[]
  /** Rows fetched from the heap (heap.tuple), the heap pages they're on, how many were visible, and how many of those passed the filter. */
  fetched: number
  fetchedPages: number[]
  fetchedVisible: number
  fetchedMatched: number
  /** Visibility map checks (an index-only scan), and how many found the page all-visible. */
  checks: number
  allVisible: number
  /** Rows passed up to the node above, by that node's child (the node passing them). */
  passedUp: Map<number, number>
  /** Rows sent to the result, and the first and last of them (counting from 0). */
  resultRows: number
  firstResultRow: number | null
  lastResultRow: number | null
  /** In a top-N heapsort, rows that took the worst kept row's place, and rows dropped without being kept. */
  kept: number
  dropped: number
  /** Rows a Limit skipped for its OFFSET. */
  skipped: number
}

/** Counts what the events from `start` to `end` did. */
export function summarize(trace: Trace, start: number, end: number): StretchSummary {
  const summary: StretchSummary = {
    events: end - start,
    hits: 0,
    reads: 0,
    ahead: 0,
    scannedPages: [],
    rowsChecked: 0,
    rowsMatched: 0,
    entries: 0,
    marked: 0,
    leafPages: [],
    fetched: 0,
    fetchedPages: [],
    fetchedVisible: 0,
    fetchedMatched: 0,
    checks: 0,
    allVisible: 0,
    passedUp: new Map(),
    resultRows: 0,
    firstResultRow: null,
    lastResultRow: null,
    kept: 0,
    dropped: 0,
    skipped: 0,
  }
  const seen = { scanned: new Set<number>(), leaves: new Set<number>(), fetched: new Set<number>() }
  for (let i = start; i < end; i++) {
    const event = trace.events[i]
    switch (event.type) {
      case 'buffer.hit':
      case 'buffer.read':
        if (event.type === 'buffer.hit') summary.hits++
        else summary.reads++
        if (event.ahead === true) summary.ahead++
        break
      case 'heap.page':
        addPage(summary.scannedPages, seen.scanned, event.page.block)
        summary.rowsChecked += event.checkedRows ?? event.visibleRows
        summary.rowsMatched += event.matchedRows
        break
      case 'index.entry':
        summary.entries++
        if (event.bitmap === true) summary.marked++
        addPage(summary.leafPages, seen.leaves, event.page.block)
        break
      case 'heap.tuple':
        summary.fetched++
        addPage(summary.fetchedPages, seen.fetched, event.row.block)
        if (event.visible !== null) summary.fetchedVisible++
        if (event.matched) summary.fetchedMatched++
        break
      case 'visibility.check':
        summary.checks++
        if (event.allVisible) summary.allVisible++
        break
      case 'row.emit':
        if (event.resultIndex === null) {
          summary.passedUp.set(event.node, (summary.passedUp.get(event.node) ?? 0) + 1)
        } else {
          summary.resultRows++
          summary.firstResultRow ??= event.resultIndex
          summary.lastResultRow = event.resultIndex
        }
        break
      case 'sort.keep':
        summary.kept++
        break
      case 'sort.discard':
        summary.dropped++
        break
      case 'limit.skip':
        summary.skipped++
        break
    }
  }
  return summary
}

/** Adds a page to a list of pages in the order first met, once. Pages come in runs, so the last one is checked first. */
function addPage(pages: number[], seen: Set<number>, block: number) {
  if (pages.at(-1) === block || seen.has(block)) return
  seen.add(block)
  pages.push(block)
}

const integer = new Intl.NumberFormat('en-US')

/**
 * The caption for a stretch, from its summary: what the scan went through,
 * what it found, and where the rows went, e.g. "Heap pages 40–47: 1,256 rows
 * visible to the query, checked against the filter; none pass. 8 pages read
 * from disk into shared buffers."
 */
export function describeStretch(trace: Trace, nodes: Map<number, NodeInfo>, step: Step): string {
  const summary = summarize(trace, step.start, step.end)
  const nodeIds = new Set<number>()
  for (let i = step.start; i < step.end; i++) nodeIds.add(trace.events[i].node)
  const hasFilter = [...nodeIds].some((id) => nodes.get(id)?.hasFilter === true)
  const relations = new Map(trace.relations.map((relation) => [relation.id, relation]))
  const sentences: string[] = []

  if (summary.scannedPages.length > 0) {
    const visible = `${rows(summary.rowsChecked)} visible to the query`
    sentences.push(
      hasFilter
        ? `${capitalize(heapPages(summary.scannedPages))}: ${visible}, checked against the filter; ${passes(summary.rowsMatched)}.`
        : `${capitalize(heapPages(summary.scannedPages))}: ${visible}.`,
    )
  }
  if (summary.entries > 0) {
    const leaves =
      summary.leafPages.length === 1
        ? `leaf ${pageName({ relation: indexOf(trace), block: summary.leafPages[0] }, relations)}`
        : `${integer.format(summary.leafPages.length)} leaf pages`
    const entries = `${integer.format(summary.entries)} index ${summary.entries === 1 ? 'entry matches' : 'entries match'} on ${leaves}`
    if (summary.marked === summary.entries) {
      sentences.push(`${entries}; the scan marks their rows in the bitmap instead of fetching them.`)
    } else {
      sentences.push(`${entries}.`)
    }
  }
  if (summary.checks > 0) {
    const fetchedAfter = summary.checks - summary.allVisible
    sentences.push(
      `The visibility map marks the heap page all-visible for ${integer.format(summary.allVisible)} of ${integer.format(summary.checks)} ${summary.checks === 1 ? 'entry' : 'entries'}${fetchedAfter > 0 ? `; the other ${integer.format(fetchedAfter)} ${fetchedAfter === 1 ? 'row is' : 'rows are'} fetched from the heap` : ', so no row is fetched from the heap'}.`,
    )
  }
  if (summary.fetched > 0) {
    const invisible = summary.fetched - summary.fetchedVisible
    let fetched = `${rows(summary.fetched)} fetched from ${heapPages(summary.fetchedPages)}: ${integer.format(summary.fetchedVisible)} visible`
    if (hasFilter) fetched += `, ${passes(summary.fetchedMatched)} the filter`
    if (invisible > 0) fetched += `; ${integer.format(invisible)} not visible to the query`
    sentences.push(`${capitalize(fetched)}.`)
  }
  const accesses = summary.reads + summary.hits
  if (accesses > 0) {
    const parts: string[] = []
    if (summary.reads > 0) parts.push(`${integer.format(summary.reads)} ${summary.reads === 1 ? 'page' : 'pages'} read from disk into shared buffers`)
    if (summary.hits > 0) parts.push(`${integer.format(summary.hits)} already there (${summary.hits === 1 ? 'a hit' : 'hits'})`)
    const ahead = summary.ahead > 0 ? `, ${integer.format(summary.ahead)} of them ahead of the scan, which stopped before it got there` : ''
    sentences.push(`Buffers: ${parts.join(', ')}${ahead}.`)
  }
  for (const [node, count] of summary.passedUp) {
    const parent = nodes.get(node)?.parent
    const to = parent === undefined ? 'the node above' : (nodes.get(parent)?.title ?? `plan node ${parent}`)
    sentences.push(`${capitalize(rows(count))} ${count === 1 ? 'goes' : 'go'} up to ${to}.`)
  }
  if (summary.kept > 0 || summary.dropped > 0) {
    const parts: string[] = []
    if (summary.kept > 0) {
      parts.push(`${rows(summary.kept)} ${summary.kept === 1 ? 'sorts' : 'sort'} before the worst row kept and ${summary.kept === 1 ? 'takes' : 'take'} its place`)
    }
    if (summary.dropped > 0) {
      const one = summary.dropped === 1
      parts.push(`${rows(summary.dropped)} ${one ? 'doesn’t' : 'don’t'}${summary.kept > 0 ? '' : ' sort before the worst row kept'}, so ${one ? 'it’s' : 'they’re'} dropped`)
    }
    sentences.push(`In the top-N heapsort, ${parts.join('; ')}.`)
  }
  if (summary.skipped > 0) sentences.push(`The Limit skips ${rows(summary.skipped)} for its OFFSET.`)
  if (summary.resultRows > 0 && summary.firstResultRow !== null && summary.lastResultRow !== null) {
    sentences.push(
      summary.resultRows === 1
        ? `1 row goes to the result: row ${integer.format(summary.firstResultRow + 1)}.`
        : `${rows(summary.resultRows)} go to the result: rows ${integer.format(summary.firstResultRow + 1)} to ${integer.format(summary.lastResultRow + 1)}.`,
    )
  }
  return sentences.join(' ')
}

/** The index the trace reads, for naming leaf pages. */
function indexOf(trace: Trace): number {
  return trace.relations.find((relation) => relation.kind === 'index')?.id ?? -1
}

/** "heap page 37", "heap pages 40 to 47", or "12 heap pages, from 3 to 90" when they aren't one after another. */
function heapPages(pages: number[]): string {
  if (pages.length === 1) return `heap page ${integer.format(pages[0])}`
  const lowest = Math.min(...pages)
  const highest = Math.max(...pages)
  if (highest - lowest + 1 === pages.length) return `heap pages ${integer.format(lowest)} to ${integer.format(highest)}`
  return `${integer.format(pages.length)} heap pages, from ${integer.format(lowest)} to ${integer.format(highest)}`
}

function passes(count: number) {
  if (count === 0) return 'none pass'
  return `${integer.format(count)} ${count === 1 ? 'passes' : 'pass'}`
}

function rows(count: number) {
  return `${integer.format(count)} ${count === 1 ? 'row' : 'rows'}`
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
