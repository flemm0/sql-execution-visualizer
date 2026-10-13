import type { ReactNode } from 'react'
import type { IndexPageItem, IndexPageView, TablePageItem, TablePageView } from '../db/pageBrowser'
import { LinePointerText, PageHeaderText, VisibilityText } from './Internals'
import type { PageTarget, PageViewData, PageViewState } from './usePageView'

const integer = new Intl.NumberFormat('en-US')

/** The most squares the mini-map draws; a bigger table gets several pages per square. */
const MAX_MINIMAP_CELLS = 600
/** How many of a posting list's rows an entry lists before "+N more". */
const SHOWN_ROWS = 3

interface PageBrowserProps {
  target: PageTarget
  state: PageViewState
  /** Opens another page (or relation). */
  onOpen: (target: PageTarget) => void
  /** Goes back to the last run's animation; null when there's none. */
  onBackToAnimation: (() => void) | null
  /** Show internals: line pointers, tuple headers and visibility map bits on a table page, the high key on an index page. */
  internals: boolean
}

/**
 * The visualization pane with a table or index opened from the schema browser
 * (ADR 0032): one page at a time, read from Postgres with pageinspect. A
 * table's page lists its line pointers and the rows the session can see; an
 * index's page lists its downlinks or entries, which lead to the pages and
 * rows they point at.
 */
export function PageBrowser({ target, state, onOpen, onBackToAnimation, internals }: PageBrowserProps) {
  const view = state.status === 'error' ? null : state.view
  // While the next page loads, the last one stays, unless it was another relation's.
  const shown = view !== null && sameRelation(view, target) ? view : null
  return (
    <div className="flex h-full flex-col text-xs" data-testid="page-browser">
      {onBackToAnimation && (
        <div className="flex border-b border-line px-3 py-1">
          <button type="button" className="btn text-xs" onClick={onBackToAnimation}>
            Back to the animation
          </button>
        </div>
      )}
      {state.status === 'error' ? (
        <p className="p-3 text-rejected" data-testid="page-error">
          {state.message}
        </p>
      ) : shown === null ? (
        <p className="p-3 text-fg-muted">Reading the page…</p>
      ) : shown.kind === 'table' && target.kind === 'table' ? (
        <TablePage view={shown} target={target} onOpen={onOpen} internals={internals} />
      ) : shown.kind === 'index' && target.kind === 'index' ? (
        <IndexPage view={shown} target={target} onOpen={onOpen} internals={internals} />
      ) : null}
    </div>
  )
}

function sameRelation(view: PageViewData, target: PageTarget) {
  if (view.kind === 'table') return target.kind === 'table' && view.table.name === target.table.name && view.table.schema === target.table.schema
  return target.kind === 'index' && view.index.name === target.index && view.table.schema === target.table.schema
}

function Header({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
      <h3 className="font-semibold" data-testid="page-title">
        {title}
      </h3>
      {children}
    </div>
  )
}

/* ---------------------------------------------------------------- tables */

function TablePage({
  view,
  target,
  onOpen,
  internals,
}: {
  view: TablePageView
  target: Extract<PageTarget, { kind: 'table' }>
  onOpen: (target: PageTarget) => void
  internals: boolean
}) {
  const pages = view.table.pages
  const open = (block: number) => onOpen({ ...target, block, highlight: null })
  const visible = view.items.filter((item) => item.values !== null).length
  return (
    <>
      <Header title={`Table ${view.table.name}`}>
        <span className="font-mono text-fg-muted">
          {integer.format(pages)} {pages === 1 ? 'page' : 'pages'}
        </span>
        {pages > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <button type="button" className="icon-btn" onClick={() => open(view.block - 1)} disabled={view.block === 0} aria-label="Previous page">
              ◀
            </button>
            <label className="flex items-center gap-1 text-fg-muted">
              heap page
              <PageNumberInput block={view.block} last={pages - 1} onChange={open} />
              / {integer.format(pages - 1)}
            </label>
            <button
              type="button"
              className="icon-btn"
              onClick={() => open(view.block + 1)}
              disabled={view.block >= pages - 1}
              aria-label="Next page"
            >
              ▶
            </button>
          </span>
        )}
      </Header>
      {pages === 0 ? (
        <p className="p-3 text-fg-muted">{view.table.name} has no pages yet: it has never held a row.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 py-2">
          <MiniMap pages={pages} current={view.block} onOpen={open} />
          <p data-testid="page-summary">
            <span className="font-mono text-heap">heap page {integer.format(view.block)}</span>
            <span className="text-fg-muted">
              {' '}
              · {integer.format(view.items.length)} line {view.items.length === 1 ? 'pointer' : 'pointers'} ·{' '}
              {integer.format(visible)} {visible === 1 ? 'row' : 'rows'} visible to this session
            </span>
          </p>
          {internals && (
            <p className="font-mono text-fg-muted" data-testid="page-internals">
              {view.header && <PageHeaderText lower={view.header.lower} upper={view.header.upper} linePointers={null} />}
              <br />
              <VisibilityText bits={view.visibility} />
            </p>
          )}
          <table className="w-max font-mono">
            <thead className="text-left text-fg-muted">
              <tr>
                <th className="pr-3 font-normal">ctid</th>
                {internals && <th className="pr-3 font-normal">line pointer · tuple header</th>}
                {view.columns.map((column) => (
                  <th key={column} className="pr-3 font-normal">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.items.map((item) => (
                <LinePointerRow
                  key={item.offset}
                  item={item}
                  block={view.block}
                  columns={view.columns.length}
                  internals={internals}
                  highlighted={item.offset === target.highlight && view.block === target.block}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/** What a line pointer that holds no row the session can see stands for. */
const NO_ROW: Record<TablePageItem['state'], string> = {
  normal: 'not visible to this session: deleted, replaced by an UPDATE, or not committed',
  dead: 'dead: its row was removed, but an index may still point here',
  unused: 'unused: free for a new row',
  redirect: 'redirect',
}

function LinePointerRow({
  item,
  block,
  columns,
  internals,
  highlighted,
}: {
  item: TablePageItem
  block: number
  columns: number
  internals: boolean
  highlighted: boolean
}) {
  return (
    <tr
      className={`${highlighted ? 'bg-heap/20' : ''} ${item.values === null ? 'text-fg-muted' : ''}`}
      data-testid="page-row"
      data-state={item.values === null ? item.state : 'visible'}
      data-highlighted={highlighted ? '' : undefined}
      ref={(element) => {
        if (highlighted) element?.scrollIntoView({ block: 'nearest' })
      }}
    >
      <td className="pr-3 text-heap">
        ({block},{item.offset})
      </td>
      {internals && (
        <td className="pr-3 whitespace-nowrap">
          <LinePointerText lp={item} />
        </td>
      )}
      {item.values === null ? (
        <td colSpan={Math.max(1, columns)} className="pr-3 italic">
          {item.state === 'redirect' ? `redirect → (${block},${item.redirectTo}), a newer version of the row` : NO_ROW[item.state]}
        </td>
      ) : (
        item.values.map((value, column) => (
          <td key={column} className="max-w-64 truncate pr-3" title={value ?? 'NULL'}>
            {value === null ? <span className="text-fg-muted italic">NULL</span> : value}
          </td>
        ))
      )}
    </tr>
  )
}

/** A page number box: Enter (or leaving it) opens that page. */
function PageNumberInput({ block, last, onChange }: { block: number; last: number; onChange: (block: number) => void }) {
  function commit(text: string) {
    const number = Math.round(Number(text))
    if (text.trim() !== '' && Number.isFinite(number) && number !== block) onChange(Math.min(Math.max(0, number), last))
  }
  return (
    <input
      // Keyed by the page, so it shows the new page's number after each move.
      key={block}
      type="number"
      className="w-16 rounded border border-line bg-surface-2 px-1 py-0.5 font-mono text-fg"
      min={0}
      max={last}
      defaultValue={block}
      aria-label="Page number"
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget.value)
      }}
      onBlur={(event) => commit(event.target.value)}
    />
  )
}

/** Every page of the table as a square; clicking one opens it (the first of its pages, when a square stands for several). */
function MiniMap({ pages, current, onOpen }: { pages: number; current: number; onOpen: (block: number) => void }) {
  const perCell = Math.max(1, Math.ceil(pages / MAX_MINIMAP_CELLS))
  const cells = Math.ceil(pages / perCell)
  const currentCell = Math.floor(current / perCell)
  return (
    <div>
      <div className="flex flex-wrap gap-px" aria-label="Pages of the table" data-testid="page-minimap">
        {Array.from({ length: cells }, (_, cell) => (
          // The page number box and the arrows do the same from the keyboard.
          <span
            key={cell}
            className={`size-2 cursor-pointer ${cell === currentCell ? 'bg-heap outline outline-fg' : 'bg-surface-2 hover:bg-heap/50'}`}
            title={perCell === 1 ? `heap page ${cell}` : `heap pages ${cell * perCell}–${Math.min(pages, (cell + 1) * perCell) - 1}`}
            data-current={cell === currentCell ? '' : undefined}
            onClick={() => onOpen(cell * perCell)}
          />
        ))}
      </div>
      {perCell > 1 && <p className="mt-1 text-fg-muted">each square: {integer.format(perCell)} pages</p>}
    </div>
  )
}

/* --------------------------------------------------------------- indexes */

function IndexPage({
  view,
  target,
  onOpen,
  internals,
}: {
  view: IndexPageView
  target: Extract<PageTarget, { kind: 'index' }>
  onOpen: (target: PageTarget) => void
  internals: boolean
}) {
  const page = view.page
  /** Opens another page of the index, remembering this one for Back. */
  const open = (block: number) => onOpen({ ...target, block, history: [...target.history, page.block] })
  const back = target.history.at(-1)
  const kind = page.isLeaf ? 'leaf' : page.isRoot ? 'root' : `level ${page.level}`
  const count = view.items.length
  return (
    <>
      <Header title={`Index ${view.index.name}`}>
        <span className="font-mono text-fg-muted">
          on {view.table.name} · {view.levels} {view.levels === 1 ? 'level' : 'levels'} · {integer.format(view.index.pages)}{' '}
          {view.index.pages === 1 ? 'page' : 'pages'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="btn text-xs"
            onClick={() => back !== undefined && onOpen({ ...target, block: back, history: target.history.slice(0, -1) })}
            disabled={back === undefined}
          >
            Back
          </button>
          <button type="button" className="btn text-xs" onClick={() => onOpen({ ...target, block: null, history: [] })} disabled={page.isRoot}>
            Root
          </button>
          <button
            type="button"
            className="btn font-mono text-xs"
            onClick={() => page.prev !== null && open(page.prev)}
            disabled={page.prev === null}
            aria-label="Page to the left"
          >
            ← {page.prev === null ? 'none' : `idx p${page.prev}`}
          </button>
          <button
            type="button"
            className="btn font-mono text-xs"
            onClick={() => page.next !== null && open(page.next)}
            disabled={page.next === null}
            aria-label="Page to the right"
          >
            {page.next === null ? 'none' : `idx p${page.next}`} →
          </button>
        </span>
      </Header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 py-2">
        <p data-testid="page-summary">
          <span className="font-mono text-index">
            idx p{page.block} · {kind}
          </span>
          <span className="text-fg-muted">
            {' '}
            · {integer.format(count)} {page.isLeaf ? (count === 1 ? 'entry' : 'entries') : count === 1 ? 'downlink' : 'downlinks'}
            {page.isIgnored && ' · deleted: searches skip this page'}
            {' · '}
            key: {view.keyColumns.join(', ')}
          </span>
        </p>
        {view.unreadableKeys && <p className="text-fg-muted">{view.unreadableKeys}</p>}
        {internals && (
          <p className="font-mono text-fg-muted" data-testid="page-high-key">
            {view.highKey === null
              ? 'no high key: the rightmost page on its level has no upper bound'
              : `high key (item 1): ${keyText(view.highKey, view.keyColumns.length)}, the upper bound of the keys on this page`}
          </p>
        )}
        <p className="text-fg-muted">
          {page.isLeaf
            ? 'Each entry is a key and the heap row it points at; click a row to open its heap page.'
            : 'Each downlink leads to the child page holding the keys from its key up to the next one’s; click one to go down.'}
        </p>
        <ol className="font-mono">
          {view.items.map((item) => (
            <IndexItemRow
              key={item.offset}
              item={item}
              keyColumns={view.keyColumns.length}
              onChild={open}
              onRow={(row) => onOpen({ kind: 'table', table: target.table, block: row.block, highlight: row.offset })}
            />
          ))}
        </ol>
      </div>
    </>
  )
}

function IndexItemRow({
  item,
  keyColumns,
  onChild,
  onRow,
}: {
  item: IndexPageItem
  keyColumns: number
  onChild: (block: number) => void
  onRow: (row: { block: number; offset: number }) => void
}) {
  const hidden = item.rows.length - SHOWN_ROWS
  return (
    <li className="flex items-baseline gap-2" data-testid="index-item" data-dead={item.dead ? '' : undefined}>
      <span className="w-8 shrink-0 text-right text-fg-muted">{item.offset}</span>
      <span
        className={`max-w-96 truncate ${item.dead ? 'line-through opacity-60' : ''}`}
        title={keyText(item, keyColumns)}
        data-testid="index-key"
      >
        {keyText(item, keyColumns)}
      </span>
      {item.child !== null && (
        <button type="button" className="text-index hover:underline" onClick={() => onChild(item.child as number)}>
          → idx p{item.child}
        </button>
      )}
      {item.rows.slice(0, SHOWN_ROWS).map((row) => (
        <button key={`${row.block},${row.offset}`} type="button" className="text-heap hover:underline" onClick={() => onRow(row)}>
          → ({row.block},{row.offset})
        </button>
      ))}
      {hidden > 0 && <span className="text-fg-muted">+{integer.format(hidden)} more rows</span>}
      {item.dead && <span className="text-fg-muted">dead</span>}
    </li>
  )
}

/**
 * A key as text: its values separated by commas, NULL for NULL, and −∞ for
 * the columns a downlink dropped (all of them for a page's first downlink).
 * When the keys can't be read, their bytes.
 */
export function keyText(item: Pick<IndexPageItem, 'key' | 'keyBytes'>, keyColumns: number): string {
  if (item.key === null) return item.keyBytes === '' ? '−∞' : item.keyBytes
  const values = item.key.map((value) => value ?? 'NULL')
  while (values.length < keyColumns) values.push('−∞')
  return values.join(', ')
}
