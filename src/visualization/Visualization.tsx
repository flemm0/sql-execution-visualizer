import { Fragment, useMemo, type ReactNode } from 'react'
import type { Plan, PlanNode } from '../db/plan'
import {
  rowName,
  shortKey,
  shortPageName,
  stateAt,
  type BitmapView,
  type HeapRow,
  type IndexView,
  type LimitView,
  type NodeInfo,
  type PageMark,
  type PlaybackState,
  type SortView,
} from '../player/playback'
import { describeStretch, isStretch } from '../player/condense'
import type { Player } from '../player/usePlayer'
import { MAX_TRACED_ROWS, type HeapPageContents, type PageRef, type RowRef, type Trace, type TraceRelation } from '../replay/trace'
import { allNodes, type Validation } from '../replay/validate'
import { NodeTitle, Term } from '../glossary/Term'
import { BtreeView } from './BtreeView'
import { LinePointerText, PageHeaderText, VisibilityText } from './Internals'
import { PlayerControls } from './PlayerControls'

const integer = new Intl.NumberFormat('en-US')

/** How many buffer slots the shared buffers zone draws: the pages the query asked for most recently. */
const SHOWN_SLOTS = 40
/** The most squares the mini-map draws; a bigger table gets several pages per square. */
const MAX_MINIMAP_CELLS = 600

interface VisualizationProps {
  plan: Plan
  trace: Trace
  validation: Validation
  /** App's player, with this trace loaded: the results pane follows the same step. */
  player: Player
  /** Show internals: line pointers, tuple headers, visibility map bits and high keys. */
  internals: boolean
}

/**
 * The visualization pane (docs/UX.md#visualization): a replayed query played
 * step by step through three zones, index → shared buffers → heap, with a
 * caption for each step and the player's controls.
 */
export function Visualization({ plan, trace, validation, player, internals }: VisualizationProps) {
  const planNodes = useMemo(() => new Map(allNodes(plan.root).map((node) => [node.id, node])), [plan])
  const nodeInfo = useMemo(() => {
    const info = new Map<number, NodeInfo>()
    for (const node of planNodes.values()) info.set(node.id, { title: node.title, hasFilter: node.filter !== null })
    // Each node passes its rows up to its parent.
    for (const node of planNodes.values()) {
      for (const child of node.children) {
        const childInfo = info.get(child.id)
        if (childInfo !== undefined) childInfo.parent = node.id
      }
    }
    return info
  }, [planNodes])
  const relations = useMemo(() => new Map(trace.relations.map((relation) => [relation.id, relation])), [trace])
  const state = useMemo(() => stateAt(trace, nodeInfo, player.events), [trace, nodeInfo, player.events])
  // A stretch (several events played as one step) gets a caption summing up its events.
  const step = player.current
  const stretchCaption = useMemo(
    () => (step !== null && isStretch(step) ? describeStretch(trace, nodeInfo, step) : null),
    [trace, nodeInfo, step],
  )
  const caption = player.position === 0 ? readyCaption(player, state.caption) : (stretchCaption ?? state.caption)
  const node = state.lastNode === null ? (planNodes.get(0) ?? null) : (planNodes.get(state.lastNode) ?? null)

  return (
    <div className="flex h-full flex-col text-xs" data-testid="visualization">
      <NodeLine node={node} state={state} />
      {state.limit && <LimitLine limit={state.limit} />}
      {!validation.ok && (
        <p className="border-b border-l-4 border-line border-l-rejected bg-surface-2 px-3 py-1.5" data-testid="viz-mismatch">
          The replay doesn’t match what Postgres reported (see the checks in the plan pane), so this animation may not
          show exactly what Postgres did.
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3">
        {state.index && <IndexZone view={state.index} state={state} trace={trace} internals={internals} />}
        <BuffersZone state={state} relations={relations} />
        <HeapZone state={state} trace={trace} internals={internals} />
        {state.sort && <SortZone sort={state.sort} />}
      </div>
      <div className="flex items-start gap-3 border-t border-line px-3 py-2">
        <p className="flex-1 text-sm" aria-live="polite" data-testid="viz-caption">
          {caption}
        </p>
        <StretchControl player={player} />
      </div>
      <PlayerControls player={player} trace={trace} />
    </div>
  )
}

/** The caption before the first step: how many steps there are, and how many events they condense. */
function readyCaption(player: Player, uncondensed: string): string {
  if (player.totalEvents <= player.steps) return uncondensed
  return `Ready to replay ${integer.format(player.totalEvents)} events in ${integer.format(player.steps)} steps: repetitive stretches play as one step each, and any of them can be expanded. Press play, or step through them one at a time.`
}

/**
 * On a stretch, how many events it groups and a button to expand it; inside
 * an expanded stretch, which of its events this is and a button to collapse
 * it again.
 */
function StretchControl({ player }: { player: Player }) {
  const step = player.current
  if (step === null) return null
  if (isStretch(step)) {
    return (
      <p className="flex shrink-0 items-center gap-2 text-fg-muted" data-testid="viz-stretch" data-kind="stretch">
        <span>stretch of {integer.format(step.end - step.start)} events</span>
        <button type="button" className="btn text-xs" onClick={player.expand}>
          Expand
        </button>
      </p>
    )
  }
  if (step.stretch === undefined) return null
  const count = step.stretch.end - step.stretch.start
  return (
    <p className="flex shrink-0 items-center gap-2 text-fg-muted" data-testid="viz-stretch" data-kind="expanded">
      <span>
        event {integer.format(step.start - step.stretch.start + 1)} of {integer.format(count)} in an expanded stretch
      </span>
      <button type="button" className="btn text-xs" onClick={player.collapse}>
        Collapse
      </button>
    </p>
  )
}

/**
 * The plan node working now (or that just finished), with the rows it has
 * passed on so far (to the result, or for a bitmap index scan, into its
 * bitmap) against the planner's estimate.
 */
function NodeLine({ node, state }: { node: PlanNode | null; state: PlaybackState }) {
  if (node === null) return null
  // A parent is active while its child works for it (a Sort while the scan below gives it rows).
  const status = state.working.includes(node.id)
    ? 'active'
    : state.stopped.has(node.id)
      ? 'stopped'
      : state.position === 0
        ? 'waiting'
        : 'done'
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-3 py-1.5" data-testid="viz-node">
      <span className="font-semibold">
        <NodeTitle title={node.title} nodeType={node.nodeType} />
      </span>
      <span className="text-fg-muted">{status}</span>
      <span className="font-mono text-fg-muted" data-testid="viz-rows">
        rows: {integer.format(state.nodeRows.get(node.id) ?? 0)} so far / <Term term="estimated rows">est.</Term>{' '}
        {integer.format(node.estimatedRows)}
      </span>
    </div>
  )
}

/** What the Limit has done so far: rows skipped for its OFFSET, rows passed on against its LIMIT, and whether it stopped. */
function LimitLine({ limit }: { limit: LimitView }) {
  const parts: string[] = []
  if (limit.offset > 0) parts.push(`OFFSET ${integer.format(limit.offset)}: ${integer.format(limit.skipped)} skipped`)
  parts.push(
    limit.count === null
      ? `${integer.format(limit.passed)} passed on`
      : `LIMIT ${integer.format(limit.count)}: ${integer.format(limit.passed)} passed on`,
  )
  if (limit.stopped) parts.push('stopped: it asks for no more rows')
  return (
    <p className="border-b border-line px-3 py-1 font-mono text-fg-muted" data-testid="viz-limit">
      Limit · {parts.join(' · ')}
    </p>
  )
}

function Zone({
  title,
  heading = title,
  testId,
  wide = false,
  children,
}: {
  title: string
  /** The heading as shown, with its terms marked; `title` (its plain text) names the zone for screen readers. */
  heading?: ReactNode
  testId: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    // Each zone scrolls on its own when the pane is short.
    <section
      className={`flex min-h-0 min-w-48 flex-col gap-2 overflow-y-auto py-3 ${wide ? 'flex-[2]' : 'flex-1'}`}
      data-testid={testId}
      aria-label={title}
    >
      <h3 className="text-[11px] tracking-wide text-fg-muted uppercase">{heading}</h3>
      {children}
    </section>
  )
}

/** The current search down the index, drawn as the B-tree pages it went through, with the entries that matched. */
function IndexZone({ view, state, trace, internals }: { view: IndexView; state: PlaybackState; trace: Trace; internals: boolean }) {
  const pages = useMemo(
    () => new Map(trace.indexPages.filter((page) => page.relation === view.index.id).map((page) => [page.block, page])),
    [trace, view.index.id],
  )
  // Entries keep every key column, so the longest key is the index's column count.
  const keyColumns = useMemo(
    () => Math.max(1, ...trace.indexPages.flatMap((page) => page.items.map((item) => item.key.length))),
    [trace],
  )
  const currentEntry = state.current?.type === 'index.entry' ? state.current.offset : null
  return (
    <Zone
      title={`Index ${view.index.name}`}
      heading={
        <>
          <Term term="index">Index</Term> {view.index.name}
        </>
      }
      testId="viz-index"
      wide
    >
      <p className="font-mono text-fg-muted">
        <Term term="index search">search</Term> {integer.format(view.searches)}
        {view.leaf && (
          <>
            {' '}
            · {integer.format(view.entryCount)} matched on <Term term="leaf">leaf</Term> idx p{view.leaf.block}
          </>
        )}
        {view.markedDead > 0 && (
          <>
            {' '}
            · {integer.format(view.markedDead)} <Term term="dead entry">marked dead</Term>
          </>
        )}
      </p>
      <BtreeView
        view={view}
        pages={pages}
        keyColumns={keyColumns}
        current={currentPage(state)}
        currentEntry={currentEntry}
        highKeys={internals}
      />
    </Zone>
  )
}

/** The pages the query has asked for, as buffer slots, with running hit and read counts. */
function BuffersZone({ state, relations }: { state: PlaybackState; relations: Map<number, TraceRelation> }) {
  const current = state.current
  const accessed = current?.type === 'buffer.hit' || current?.type === 'buffer.read' ? current : null
  const hidden = Math.max(0, state.buffers.length - SHOWN_SLOTS)
  const slots = state.buffers.slice(hidden)
  const cached = state.buffers.filter((slot) => slot.wasCached).length
  return (
    <Zone title="Shared buffers" heading={<Term term="shared buffers">Shared buffers</Term>} testId="viz-buffers">
      <p className="font-mono">
        <span data-testid="viz-hits">
          <Term term="buffer hit">hits</Term> {integer.format(state.hits)}
        </span>{' '}
        ·{' '}
        <span data-testid="viz-reads">
          <Term term="buffer read">reads</Term> {integer.format(state.reads)}
        </span>
      </p>
      <ul className="flex flex-wrap gap-1 font-mono" aria-label="Pages this query used">
        {slots.map((slot) => {
          const kind = relations.get(slot.page.relation)?.kind ?? 'table'
          const isCurrent = accessed !== null && samePage(slot.page, accessed.page)
          // A table's visibility map is part of the table: amber, dashed. A page read ahead and never used: dotted.
          const color =
            kind === 'index'
              ? 'border-index text-index'
              : `border-heap text-heap ${slot.page.fork === 'vm' ? 'border-dashed' : ''} ${slot.ahead ? 'border-dotted' : ''}`
          // Keyed by position too, so the animation plays again on every access to the slot.
          const animation = isCurrent ? (accessed.type === 'buffer.read' ? 'slot-read' : 'slot-hit') : ''
          return (
            <li
              key={`${slot.page.relation}/${slot.page.fork ?? 'main'}/${slot.page.block}/${isCurrent ? state.position : ''}`}
              className={`rounded border px-1 ${color} ${isCurrent ? 'bg-surface-2' : 'opacity-60'} ${animation}`}
              data-testid="viz-slot"
              data-current={isCurrent ? accessed.type : undefined}
              data-ahead={slot.ahead ? '' : undefined}
              title={
                (slot.wasCached ? 'Was already in shared buffers' : 'Read from disk by this query') +
                (slot.ahead ? '; asked for ahead of the scan, which stopped before it got there' : '')
              }
            >
              {shortPageName(slot.page, relations)}
            </li>
          )
        })}
      </ul>
      <p className="text-fg-muted">
        {integer.format(state.buffers.length)} {state.buffers.length === 1 ? 'page' : 'pages'} used so far
        {cached > 0 && `, ${integer.format(cached)} already cached`}
        {hidden > 0 && ` (the latest ${SHOWN_SLOTS} shown)`}
      </p>
    </Zone>
  )
}

/** The table: a mini-map of its pages, and the page being read now in detail. */
function HeapZone({ state, trace, internals }: { state: PlaybackState; trace: Trace; internals: boolean }) {
  const contents = useMemo(() => new Map(trace.heapPages.map((page) => [`${page.relation}/${page.block}`, page])), [trace])
  const table = state.table
  if (table === null) return null
  const heap = state.heap
  const page = heap ? (contents.get(`${heap.page.relation}/${heap.page.block}`) ?? null) : null
  const pageCount = `${integer.format(table.pages)} ${table.pages === 1 ? 'page' : 'pages'}`
  return (
    <Zone
      title={`Heap ${table.name} (${pageCount})`}
      heading={
        <>
          <Term term="heap">Heap</Term> {table.name} ({pageCount})
        </>
      }
      testId="viz-heap"
    >
      {state.bitmap && <BitmapLine bitmap={state.bitmap} />}
      <MiniMap pages={table.pages} marks={state.pageMarks} current={heap?.page.relation === table.id ? heap.page.block : null} />
      {heap && (
        <div data-testid="viz-heap-page">
          <p>
            <span className="font-mono text-heap">heap page {integer.format(heap.page.block)}</span>
            {heap.bitmapRows !== null && (
              <span className="text-fg-muted" data-testid="viz-bitmap-rows">
                {' '}
                · {integer.format(heap.bitmapRows)} {heap.bitmapRows === 1 ? 'row' : 'rows'} marked in the bitmap
              </span>
            )}
            {heap.allVisible !== null && (
              <span className="text-fg-muted" data-testid="viz-all-visible">
                {' '}
                ·{' '}
                {heap.allVisible ? (
                  <>
                    <Term term="all-visible" />: not read, rows from the index
                  </>
                ) : (
                  <>
                    not <Term term="all-visible" />: rows fetched
                  </>
                )}
              </span>
            )}
            {heap.visibleRows !== null && (
              <span className="text-fg-muted" data-testid="viz-heap-counts">
                {' '}
                · {integer.format(heap.visibleRows)} <Term term="visible" />
                {heap.checkedRows !== null && ` · ${integer.format(heap.checkedRows)} checked before the stop`} ·{' '}
                {integer.format(heap.matchedRows ?? 0)} matched
              </span>
            )}
          </p>
          {internals && <HeapPageInternals page={page} />}
          <ul className="font-mono" aria-label="Rows on this page">
            {heap.rowCount > heap.rows.length && <li className="text-fg-muted">…</li>}
            {heap.rows.map((row, i) => (
              <HeapRowItem key={i} row={row} internals={internals} page={page} />
            ))}
          </ul>
        </div>
      )}
    </Zone>
  )
}

/**
 * A Sort (violet, an intermediate result): the rows it holds while it
 * collects them (in a top-N heapsort, the best kept, with the worst last:
 * the one a new row has to beat), then the rows it passes on in order.
 */
function SortZone({ sort }: { sort: SortView }) {
  const keys = sort.keys.map(shortKey)
  let summary: string
  if (sort.sorted) {
    summary = `sorted ${integer.format(sort.held)} ${sort.held === 1 ? 'row' : 'rows'} (${sort.method}) · ${integer.format(sort.passed)} of ${integer.format(sort.held)} passed on`
  } else if (sort.method === 'top-N heapsort') {
    summary = `top-N heapsort: keeps the best ${integer.format(sort.keeps ?? 0)} · ${integer.format(sort.received)} seen · ${integer.format(sort.dropped)} dropped`
  } else {
    summary = `in memory: ${integer.format(sort.held)} ${sort.held === 1 ? 'row' : 'rows'}`
  }
  const topN = !sort.sorted && sort.method === 'top-N heapsort'
  return (
    <Zone title={`Sort by ${sort.keys.join(', ')}`} testId="viz-sort">
      <p className="font-mono text-intermediate" data-testid="viz-sort-summary">
        {summary}
      </p>
      <ul className="font-mono" aria-label="Rows in the sort">
        {!topN && !sort.sorted && sort.received > sort.rows.length && <li className="text-fg-muted">…</li>}
        {sort.rows.map((row, i) => (
          <Fragment key={`${row.row.block}/${row.row.offset}`}>
            {/* The best kept are listed, then the worst: the rows between are left out. */}
            {topN && i === sort.rows.length - 1 && sort.held > sort.rows.length && <li className="text-fg-muted">…</li>}
              <li
              className={row.latest ? 'text-intermediate' : 'text-fg'}
              data-testid="viz-sort-row"
              data-latest={row.latest ? '' : undefined}
            >
              {row.position !== null && `${integer.format(row.position + 1)}. `}
              {rowName(row.row)} {row.key.map((value, k) => `${keys[k]} ${value ?? 'NULL'}`).join(', ')}
              {topN && i === sort.rows.length - 1 && sort.rows.length > 1 && <span className="text-fg-muted"> ← worst kept</span>}
            </li>
          </Fragment>
        ))}
      </ul>
    </Zone>
  )
}

/** The bitmap (violet, an intermediate result): the rows and pages it marks, and how many of those pages have been read. */
function BitmapLine({ bitmap }: { bitmap: BitmapView }) {
  const pages = bitmap.pages.size
  return (
    <p className="font-mono text-intermediate" data-testid="viz-bitmap">
      <Term term="bitmap" />: {integer.format(bitmap.rows)} {bitmap.rows === 1 ? 'row' : 'rows'} on {integer.format(pages)}{' '}
      {pages === 1 ? 'page' : 'pages'}
      {bitmap.pagesRead > 0 && ` · ${integer.format(bitmap.pagesRead)} of ${integer.format(pages)} read`}
    </p>
  )
}

const OUTCOMES: Record<HeapRow['outcome'], { mark: string; text: string; color: string }> = {
  passed: { mark: '✓', text: 'passes', color: 'text-fg' },
  up: { mark: '✓', text: '→', color: 'text-fg' },
  emitted: { mark: '✓', text: '→ result', color: 'text-result' },
  rejected: { mark: '✗', text: 'filtered out', color: 'text-rejected' },
  invisible: { mark: '·', text: 'not visible', color: 'text-fg-muted' },
}

/**
 * A row on the current page and what became of it; with Show internals,
 * its line pointer and tuple header from `page` (null if the trace has none
 * for the page).
 */
function HeapRowItem({ row, internals, page }: { row: HeapRow; internals: boolean; page: HeapPageContents | null }) {
  const outcome = OUTCOMES[row.outcome]
  return (
    <li className={outcome.color} data-testid="viz-heap-row" data-outcome={row.outcome}>
      {outcome.mark} {rowName(row.row)}
      {row.visible && ` → ${rowName(row.visible)}`} {outcome.text}
      {row.to !== null && ` ${row.to}`}
      {row.resultIndex !== null && ` row ${integer.format(row.resultIndex + 1)}`}
      {internals && (
        <div className="pl-3 text-[11px]">
          <RowInternals page={page} row={row.row} />
          {row.visible && <RowInternals page={page} row={row.visible} />}
        </div>
      )}
    </li>
  )
}

/** A row's line pointer and tuple header, or why the trace has none for it. */
function RowInternals({ page, row }: { page: HeapPageContents | null; row: RowRef }) {
  const lp = page?.linePointers.find((each) => each.offset === row.offset)
  if (lp) {
    return (
      <div>
        <LinePointerText lp={lp} />
      </div>
    )
  }
  let why = 'internals weren’t captured for this page'
  if (page && page.header === null) why = 'the page wasn’t read, so its line pointers aren’t shown'
  else if (page && !page.complete) {
    why = `line pointer not captured: a trace keeps them for the first ${integer.format(MAX_TRACED_ROWS)} rows it names only`
  }
  return (
    <div className="text-fg-muted italic" data-testid="internals-missing">
      lp {row.offset}: {why}
    </div>
  )
}

/** The current page's header and visibility map bits, under Show internals. */
function HeapPageInternals({ page }: { page: HeapPageContents | null }) {
  return (
    <p className="font-mono text-[11px] text-fg-muted" data-testid="viz-heap-internals">
      {page === null ? (
        'Internals weren’t captured for this page.'
      ) : (
        <>
          {page.header ? (
            <PageHeaderText lower={page.header.lower} upper={page.header.upper} linePointers={page.header.linePointers} />
          ) : (
            'not read by this query: no page header'
          )}
          <br />
          <VisibilityText bits={page.visibility} />
        </>
      )}
    </p>
  )
}

/**
 * Every page of the table as a square, in order: the ones the query has been
 * through (amber), the ones that gave rows to the result (emerald), the ones
 * an index-only scan didn't read because they're all-visible (sky, the
 * index's color: their rows came from the index), the ones a bitmap marks
 * and the scan hasn't read yet (violet), and the one being read now
 * (outlined). A big table gets several pages per square, which shows the
 * strongest of their marks (MARK_RANK).
 */
function MiniMap({ pages, marks, current }: { pages: number; marks: Map<number, PageMark>; current: number | null }) {
  const perCell = Math.max(1, Math.ceil(pages / MAX_MINIMAP_CELLS))
  const cells = Math.ceil(pages / perCell)
  const cellMarks: (PageMark | undefined)[] = new Array(cells)
  for (const [block, mark] of marks) {
    const cell = Math.floor(block / perCell)
    const shown = cellMarks[cell]
    if (shown === undefined || MARK_RANK.indexOf(mark) > MARK_RANK.indexOf(shown)) cellMarks[cell] = mark
  }
  const currentCell = current === null ? -1 : Math.floor(current / perCell)
  return (
    <div>
      <div className="flex flex-wrap gap-px" role="img" aria-label="Pages of the table the query has read" data-testid="viz-minimap">
        {Array.from({ length: cells }, (_, cell) => {
          const mark = cellMarks[cell]
          const fill = mark === undefined ? 'bg-surface-2' : MARK_FILLS[mark]
          return (
            <span
              key={cell}
              className={`size-1.5 ${fill} ${cell === currentCell ? 'outline outline-fg' : ''}`}
              data-mark={mark}
              data-current={cell === currentCell ? '' : undefined}
            />
          )
        })}
      </div>
      {perCell > 1 && <p className="mt-1 text-fg-muted">each square: {integer.format(perCell)} pages</p>}
    </div>
  )
}

const MARK_FILLS: Record<PageMark, string> = {
  ahead: 'bg-heap/40',
  touched: 'bg-heap',
  result: 'bg-result',
  fromIndex: 'bg-index',
  bitmap: 'bg-intermediate',
}

/** Which mark a square for several pages shows: the last of theirs in this list. */
const MARK_RANK: PageMark[] = ['ahead', 'bitmap', 'fromIndex', 'touched', 'result']

/** The page the last step asked for or went through, if any. */
function currentPage(state: PlaybackState): PageRef | null {
  const event = state.current
  if (event === null) return null
  if ('page' in event) return event.page
  return null
}

function samePage(a: PageRef, b: PageRef | null) {
  return b !== null && a.relation === b.relation && a.block === b.block && a.fork === b.fork
}
