import { useMemo, type ReactNode } from 'react'
import type { Plan, PlanNode } from '../db/plan'
import {
  rowName,
  shortPageName,
  stateAt,
  type HeapRow,
  type IndexView,
  type NodeInfo,
  type PageMark,
  type PlaybackState,
} from '../player/playback'
import type { Player } from '../player/usePlayer'
import type { PageRef, Trace, TraceRelation } from '../replay/trace'
import { allNodes, type Validation } from '../replay/validate'
import { BtreeView } from './BtreeView'
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
}

/**
 * The visualization pane (docs/UX.md#visualization): a replayed query played
 * step by step through three zones, index → shared buffers → heap, with a
 * caption for each step and the player's controls.
 */
export function Visualization({ plan, trace, validation, player }: VisualizationProps) {
  const planNodes = useMemo(() => new Map(allNodes(plan.root).map((node) => [node.id, node])), [plan])
  const nodeInfo = useMemo(() => {
    const info = new Map<number, NodeInfo>()
    for (const node of planNodes.values()) info.set(node.id, { title: node.title, hasFilter: node.filter !== null })
    return info
  }, [planNodes])
  const relations = useMemo(() => new Map(trace.relations.map((relation) => [relation.id, relation])), [trace])
  const state = useMemo(() => stateAt(trace, nodeInfo, player.position), [trace, nodeInfo, player.position])
  const node = state.lastNode === null ? (planNodes.get(0) ?? null) : (planNodes.get(state.lastNode) ?? null)

  return (
    <div className="flex h-full flex-col text-xs" data-testid="visualization">
      <NodeLine node={node} state={state} />
      {!validation.ok && (
        <p className="border-b border-l-4 border-line border-l-rejected bg-surface-2 px-3 py-1.5" data-testid="viz-mismatch">
          The replay doesn’t match what Postgres reported (see the checks in the plan pane), so this animation may not
          show exactly what Postgres did.
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3">
        {state.index && <IndexZone view={state.index} state={state} trace={trace} />}
        <BuffersZone state={state} relations={relations} />
        <HeapZone state={state} />
      </div>
      <p className="border-t border-line px-3 py-2 text-sm" aria-live="polite" data-testid="viz-caption">
        {state.caption}
      </p>
      <PlayerControls player={player} />
    </div>
  )
}

/** The plan node working now, with the rows it has sent to the result so far against the planner's estimate. */
function NodeLine({ node, state }: { node: PlanNode | null; state: PlaybackState }) {
  if (node === null) return null
  const status = state.activeNode !== null ? 'active' : state.position === 0 ? 'waiting' : 'done'
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-3 py-1.5" data-testid="viz-node">
      <span className="font-semibold">{node.title}</span>
      <span className="text-fg-muted">{status}</span>
      <span className="font-mono text-fg-muted" data-testid="viz-rows">
        rows: {integer.format(state.resultRows)} so far / est. {integer.format(node.estimatedRows)}
      </span>
    </div>
  )
}

function Zone({ title, testId, wide = false, children }: { title: string; testId: string; wide?: boolean; children: ReactNode }) {
  return (
    // Each zone scrolls on its own when the pane is short.
    <section
      className={`flex min-h-0 min-w-48 flex-col gap-2 overflow-y-auto py-3 ${wide ? 'flex-[2]' : 'flex-1'}`}
      data-testid={testId}
      aria-label={title}
    >
      <h3 className="text-[11px] tracking-wide text-fg-muted uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** The current search down the index, drawn as the B-tree pages it went through, with the entries that matched. */
function IndexZone({ view, state, trace }: { view: IndexView; state: PlaybackState; trace: Trace }) {
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
    <Zone title={`Index ${view.index.name}`} testId="viz-index" wide>
      <p className="font-mono text-fg-muted">
        search {integer.format(view.searches)}
        {view.leaf && ` · ${integer.format(view.entryCount)} matched on idx p${view.leaf.block}`}
        {view.markedDead > 0 && ` · ${integer.format(view.markedDead)} marked dead`}
      </p>
      <BtreeView view={view} pages={pages} keyColumns={keyColumns} current={currentPage(state)} currentEntry={currentEntry} />
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
    <Zone title="Shared buffers" testId="viz-buffers">
      <p className="font-mono">
        <span data-testid="viz-hits">hits {integer.format(state.hits)}</span> ·{' '}
        <span data-testid="viz-reads">reads {integer.format(state.reads)}</span>
      </p>
      <ul className="flex flex-wrap gap-1 font-mono" aria-label="Pages this query used">
        {slots.map((slot) => {
          const kind = relations.get(slot.page.relation)?.kind ?? 'table'
          const isCurrent = accessed !== null && samePage(slot.page, accessed.page)
          // A table's visibility map is part of the table: amber, dashed.
          const color =
            kind === 'index' ? 'border-index text-index' : `border-heap text-heap ${slot.page.fork === 'vm' ? 'border-dashed' : ''}`
          // Keyed by position too, so the animation plays again on every access to the slot.
          const animation = isCurrent ? (accessed.type === 'buffer.read' ? 'slot-read' : 'slot-hit') : ''
          return (
            <li
              key={`${slot.page.relation}/${slot.page.fork ?? 'main'}/${slot.page.block}/${isCurrent ? state.position : ''}`}
              className={`rounded border px-1 ${color} ${isCurrent ? 'bg-surface-2' : 'opacity-60'} ${animation}`}
              data-testid="viz-slot"
              data-current={isCurrent ? accessed.type : undefined}
              title={slot.wasCached ? 'Was already in shared buffers' : 'Read from disk by this query'}
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
function HeapZone({ state }: { state: PlaybackState }) {
  const table = state.table
  if (table === null) return null
  const heap = state.heap
  return (
    <Zone title={`Heap ${table.name} (${integer.format(table.pages)} ${table.pages === 1 ? 'page' : 'pages'})`} testId="viz-heap">
      <MiniMap pages={table.pages} marks={state.pageMarks} current={heap?.page.relation === table.id ? heap.page.block : null} />
      {heap && (
        <div data-testid="viz-heap-page">
          <p>
            <span className="font-mono text-heap">heap page {integer.format(heap.page.block)}</span>
            {heap.allVisible !== null && (
              <span className="text-fg-muted" data-testid="viz-all-visible">
                {' '}
                · {heap.allVisible ? 'all-visible: not read, rows from the index' : 'not all-visible: rows fetched'}
              </span>
            )}
            {heap.visibleRows !== null && (
              <span className="text-fg-muted">
                {' '}
                · {integer.format(heap.visibleRows)} visible · {integer.format(heap.matchedRows ?? 0)} matched
              </span>
            )}
          </p>
          <ul className="font-mono" aria-label="Rows on this page">
            {heap.rowCount > heap.rows.length && <li className="text-fg-muted">…</li>}
            {heap.rows.map((row, i) => (
              <HeapRowItem key={i} row={row} />
            ))}
          </ul>
        </div>
      )}
    </Zone>
  )
}

const OUTCOMES: Record<HeapRow['outcome'], { mark: string; text: string; color: string }> = {
  passed: { mark: '✓', text: 'passes', color: 'text-fg' },
  emitted: { mark: '✓', text: '→ result', color: 'text-result' },
  rejected: { mark: '✗', text: 'filtered out', color: 'text-rejected' },
  invisible: { mark: '·', text: 'not visible', color: 'text-fg-muted' },
}

function HeapRowItem({ row }: { row: HeapRow }) {
  const outcome = OUTCOMES[row.outcome]
  return (
    <li className={outcome.color} data-testid="viz-heap-row" data-outcome={row.outcome}>
      {outcome.mark} {rowName(row.row)}
      {row.visible && ` → ${rowName(row.visible)}`} {outcome.text}
      {row.resultIndex !== null && ` row ${integer.format(row.resultIndex + 1)}`}
    </li>
  )
}

/**
 * Every page of the table as a square, in order: the ones the query has been
 * through (amber), the ones that gave rows to the result (emerald), the ones
 * an index-only scan didn't read because they're all-visible (sky, the
 * index's color: their rows came from the index), and the one being read
 * now (outlined). A big table gets several pages per square.
 */
function MiniMap({ pages, marks, current }: { pages: number; marks: Map<number, PageMark>; current: number | null }) {
  const perCell = Math.max(1, Math.ceil(pages / MAX_MINIMAP_CELLS))
  const cells = Math.ceil(pages / perCell)
  const cellMarks: (PageMark | undefined)[] = new Array(cells)
  for (const [block, mark] of marks) {
    const cell = Math.floor(block / perCell)
    if (cellMarks[cell] !== 'result') cellMarks[cell] = mark
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
  touched: 'bg-heap',
  result: 'bg-result',
  fromIndex: 'bg-index',
}

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
