import { useEffect, useRef } from 'react'
import type { IndexView, PathStep } from '../player/playback'
import { formatIndexKey, rowName } from '../player/playback'
import type { IndexItem, IndexPageContents, PageRef } from '../replay/trace'

const integer = new Intl.NumberFormat('en-US')

/** How many items each side of the one in focus a page box shows. */
const AROUND_FOCUS = 2
/** How many leaves the row of leaves shows, the latest last. */
const SHOWN_LEAVES = 4

interface BtreeViewProps {
  view: IndexView
  /** The index's pages as the scan found them, by block. */
  pages: Map<number, IndexPageContents>
  /** How many key columns the index has, to show the ones a downlink dropped. */
  keyColumns: number
  /** The page the step on screen went through, if any. */
  current: PageRef | null
  /** The leaf entry the step on screen matched, if it matched one. */
  currentEntry: number | null
}

/**
 * The B-tree as the current search walks it: one box per page from the root
 * down, each with its real keys around the one that matters (the downlink
 * the search followed, or the entries that matched), then the leaves the
 * scan moved right along.
 */
export function BtreeView({ view, pages, keyColumns, current, currentEntry }: BtreeViewProps) {
  const above = view.path.filter((step) => step.level > 0)
  const leaves = view.path.filter((step) => step.level === 0)
  const leaf = leaves.at(-1)
  const leafContents = leaf ? pages.get(leaf.page.block) : undefined
  const isCurrent = (page: PageRef) => current !== null && current.relation === page.relation && current.block === page.block

  return (
    <ol className="flex flex-col gap-1.5" aria-label="Pages this search went through">
      {above.map((step, i) => {
        const contents = pages.get(step.page.block)
        const next = above[i + 1] ?? leaves[0]
        return (
          <li key={i} className="flex flex-col gap-1">
            {contents && (
              <PageBox
                contents={contents}
                keyColumns={keyColumns}
                current={isCurrent(step.page)}
                focus={step.downlink}
                marks={(item) => (item.offset === step.downlink ? 'followed' : null)}
                onward={onward(step, next)}
              />
            )}
          </li>
        )
      })}
      {leaves.length > 1 && <LeafRow leaves={leaves} isCurrent={isCurrent} />}
      {leaf && leafContents && (
        <li>
          <PageBox
            contents={leafContents}
            keyColumns={keyColumns}
            current={isCurrent(leaf.page)}
            focus={currentEntry ?? view.matchedOffsets.at(-1) ?? null}
            marks={(item) => {
              if (view.deadEntries.has(`${leafContents.block}/${item.offset}`)) return 'markedDead'
              if (item.offset === currentEntry) return 'current'
              if (view.matchedOffsets.includes(item.offset)) return 'matched'
              return null
            }}
            rows={(item) => view.entries.find((entry) => entry.offset === item.offset)?.row ?? null}
          />
        </li>
      )}
    </ol>
  )
}

/** Where the search went from a page: down a downlink to its child, or right to its neighbor. */
function onward(step: PathStep, next: PathStep | undefined): string | null {
  if (next === undefined) return null
  if (step.downlink === null) return `→ right to idx p${next.page.block}`
  return `↓ item ${step.downlink} to idx p${next.page.block}`
}

/** The leaves this search has read, left to right, the latest last. */
function LeafRow({ leaves, isCurrent }: { leaves: PathStep[]; isCurrent: (page: PageRef) => boolean }) {
  const hidden = Math.max(0, leaves.length - SHOWN_LEAVES)
  return (
    <li className="flex flex-wrap items-center gap-1 font-mono" aria-label="Leaves read, left to right" data-testid="viz-leaf-row">
      {hidden > 0 && <span className="text-fg-muted">{integer.format(hidden)} earlier leaves →</span>}
      {leaves.slice(hidden).map((step, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-fg-muted">→</span>}
          <span className={`rounded border px-1 ${isCurrent(step.page) ? 'border-index text-index' : 'border-line text-fg-muted'}`}>
            idx p{step.page.block}
          </span>
        </span>
      ))}
    </li>
  )
}

/** How an item is drawn: the downlink followed, entries that matched (the current one, or earlier), or marked dead now. */
type ItemMark = 'followed' | 'current' | 'matched' | 'markedDead' | null

interface PageBoxProps {
  contents: IndexPageContents
  keyColumns: number
  /** Whether the step on screen is on this page. */
  current: boolean
  /** The item to show the neighborhood of; null shows the start of the page. */
  focus: number | null
  marks: (item: IndexItem) => ItemMark
  /** For a matched entry, the row it points at, when known. */
  rows?: (item: IndexItem) => { block: number; offset: number } | null
  /** Where the search went next from this page, e.g. "↓ item 12 to idx p13". */
  onward?: string | null
}

/** One index page: what it is, then its keys around the item in focus, and its high key. */
function PageBox({ contents, keyColumns, current, focus, marks, rows, onward = null }: PageBoxProps) {
  const box = useRef<HTMLDivElement>(null)
  // Keeps the page the step is on in view when the zone is too short for the whole path.
  useEffect(() => {
    if (current) box.current?.scrollIntoView({ block: 'nearest' })
  }, [current, focus])
  const { items } = contents
  const at = focus === null ? 0 : Math.max(0, items.findIndex((item) => item.offset === focus))
  const start = Math.max(0, Math.min(at - AROUND_FOCUS, items.length - (2 * AROUND_FOCUS + 1)))
  const end = Math.min(items.length, start + 2 * AROUND_FOCUS + 1)
  const leaf = contents.level === 0
  const kind = contents.isRoot ? 'root' : leaf ? 'leaf' : `level ${contents.level}`
  const count = `${integer.format(items.length)} ${leaf ? (items.length === 1 ? 'entry' : 'entries') : items.length === 1 ? 'downlink' : 'downlinks'}`

  return (
    <div
      ref={box}
      className={`rounded border px-2 py-1 ${current ? 'border-index' : 'border-line'}`}
      data-testid="viz-index-page"
      data-block={contents.block}
      data-current={current ? '' : undefined}
    >
      <p className="font-mono">
        <span className="text-index">idx p{contents.block}</span> <span className="text-fg">{kind}</span>
        <span className="text-fg-muted"> · {count}</span>
        {onward && <span className="text-index"> {onward}</span>}
      </p>
      <ul className="mt-1 flex flex-wrap items-stretch gap-1 font-mono" aria-label={`Items on index page ${contents.block}`}>
        {start > 0 && <Elided count={start} />}
        {items.slice(start, end).map((item) => (
          <ItemCell key={item.offset} item={item} keyColumns={keyColumns} mark={marks(item)} row={rows?.(item) ?? null} />
        ))}
        {end < items.length && <Elided count={items.length - end} />}
        <li
          className="flex flex-col rounded border border-dashed border-line px-1 text-fg-muted"
          title="The high key: every key on this page is at most this. The rightmost page of a level has none."
        >
          <span>{contents.highKey === null ? '+∞' : formatIndexKey(contents.highKey, keyColumns)}</span>
          <span className="text-[10px]">high key</span>
        </li>
      </ul>
    </div>
  )
}

const MARK_STYLES: Record<Exclude<ItemMark, null>, string> = {
  followed: 'border-index bg-index/15 text-fg',
  current: 'border-index bg-index/25 text-fg',
  matched: 'border-index/50 text-index',
  markedDead: 'border-line text-fg-muted line-through',
}

function ItemCell({ item, keyColumns, mark, row }: { item: IndexItem; keyColumns: number; mark: ItemMark; row: { block: number; offset: number } | null }) {
  const style = mark === null ? (item.dead ? 'border-line text-fg-muted line-through' : 'border-line text-fg-muted') : MARK_STYLES[mark]
  let below: string
  if (item.child !== null) below = `→ p${item.child}`
  else if (row !== null && mark !== null && mark !== 'markedDead') below = `→ ${rowName(row)}`
  else below = item.rows > 1 ? `${integer.format(item.rows)} rows` : `item ${item.offset}`
  return (
    <li
      className={`flex flex-col rounded border px-1 ${style}`}
      data-testid="viz-index-item"
      data-offset={item.offset}
      data-mark={mark ?? (item.dead ? 'dead' : undefined)}
      title={item.dead ? 'Marked dead before this query: scans skip it.' : undefined}
    >
      <span>{formatIndexKey(item.key, keyColumns)}</span>
      <span className="text-[10px]">{below}</span>
    </li>
  )
}

function Elided({ count }: { count: number }) {
  return (
    <li className="flex items-center px-1 text-fg-muted" title={`${integer.format(count)} more`}>
      …{integer.format(count)}…
    </li>
  )
}
