import { formatIndexKey, rowName, type IndexView, type PathStep } from '../player/playback'
import type { IndexPageContents, PageRef } from '../replay/trace'

/*
 * Lays out the B-tree the current search walks, drawn the way textbooks draw
 * one: each page a row of keys, with a pointer in each gap between two keys
 * leading down to the child page holding the keys between them. Real pages
 * hold hundreds of keys, so each page shows only the few around the one that
 * matters, with "…" for the rest; the other pages on a level show as faint
 * boxes with a count. Everything shown is real: the keys as Postgres writes
 * them, the pointer the search followed, the entries that matched.
 *
 * This file only computes positions (in SVG units, one per CSS pixel);
 * BtreeView.tsx draws them.
 */

/** Width of one character of the monospace font at 11px. */
export const CHAR_WIDTH = 6.6
/** Space around a key's text in its cell. */
const KEY_PADDING = 10
/** Width of the gap between two keys, where a pointer starts. */
const GAP_WIDTH = 12
/** Longest key text shown in full; longer ones are cut with "…". */
const MAX_KEY_CHARS = 16
/** Height of a page, of the page label above it, and the space between levels. */
export const NODE_HEIGHT = 24
const LABEL_HEIGHT = 16
const LEVEL_SPACE = 36
/** Space kept clear at the left and right edges, and between pages on a level. */
const MARGIN = 4
const ROW_SPACE = 22
/** Slack for comparing positions, which are sums of fractional widths. */
const EPSILON = 0.01
/** The narrowest a page drawn in full gets before the boxes for its level's other pages give way. */
const MIN_PAGE_WIDTH = 200
/** How many keys each side of the one in focus a page tries to show. */
const AROUND = 3

/** What a key or gap shows: the pointer followed, entries that matched (now or earlier), or entries dead. */
export type Mark = 'followed' | 'current' | 'matched' | 'markedDead' | 'dead'

export interface Cell {
  /** highKey: the page's high key, at its right end, drawn only with Show internals. */
  kind: 'key' | 'gap' | 'ellipsis' | 'highKey'
  /** Left edge, relative to the page. */
  x: number
  width: number
  /** The text drawn: a key, or "…" with a count for keys left out. */
  text: string
  /** The full key, when the text was cut. */
  title: string | null
  mark: Mark | null
  /** For a key or gap, the item's offset on the page (a gap's is its downlink's). */
  offset: number | null
}

export interface PageShape {
  block: number
  x: number
  y: number
  width: number
  /** What the label above says, e.g. "idx p3 · root". */
  label: string
  current: boolean
  /** An earlier page on the level, shown small: its first and last keys only. */
  compact: boolean
  cells: Cell[]
}

export interface LinkShape {
  x1: number
  y1: number
  x2: number
  y2: number
  /**
   * down: the pointer the search followed; sibling: to the other pages on the
   * level; right or left: to the next page the scan read on the level (left
   * for a backward scan).
   */
  kind: 'down' | 'sibling' | 'right' | 'left'
}

/** The other pages on a level under the same parent, as one faint box. */
export interface GhostShape {
  x: number
  y: number
  width: number
  text: string
}

/** From the latest matched entry down to the heap row it points at, or for a bitmap index scan, into the bitmap. */
export interface RowPointer {
  x: number
  y1: number
  y2: number
  text: string
  /** 'heap' when the scan fetches the row, 'bitmap' when it marks the row in its bitmap. */
  kind: 'heap' | 'bitmap'
}

export interface BtreeLayout {
  width: number
  height: number
  pages: PageShape[]
  links: LinkShape[]
  ghosts: GhostShape[]
  rowPointer: RowPointer | null
}

export interface LayoutInput {
  view: IndexView
  /** The index's pages as the scan found them, by block. */
  pages: Map<number, IndexPageContents>
  /** How many key columns the index has. */
  keyColumns: number
  /** The page the step on screen went through. */
  current: PageRef | null
  /** The leaf entry the step on screen matched. */
  currentEntry: number | null
  /** The width there is to draw in. */
  width: number
  /** Show internals: draw each page's high key at its right end. */
  highKeys?: boolean
}

const integer = new Intl.NumberFormat('en-US')

/** The B-tree of the current search: one level per row, the root at the top. */
export function layoutBtree(input: LayoutInput): BtreeLayout {
  const { view, width } = input
  // The path's pages by level, top level first, each level in the order visited.
  const levels: PathStep[][] = []
  for (const step of view.path) {
    const row = levels.find((each) => each[0].level === step.level)
    if (row) row.push(step)
    else levels.push([step])
  }
  levels.sort((a, b) => b[0].level - a[0].level)

  const layout: BtreeLayout = { width, height: 0, pages: [], links: [], ghosts: [], rowPointer: null }
  let parent: { shape: PageShape; step: PathStep; contents: IndexPageContents } | null = null
  levels.forEach((steps, row) => {
    const y = row * (LABEL_HEIGHT + NODE_HEIGHT + LEVEL_SPACE) + LABEL_HEIGHT
    const placed = layoutRow(input, steps, y, parent)
    if (placed === null) return
    layout.pages.push(...placed.shapes)
    layout.links.push(...placed.links)
    layout.ghosts.push(...placed.ghosts)
    parent = placed.last
    layout.height = y + NODE_HEIGHT
  })

  const pointer = rowPointer(input, layout)
  if (pointer) {
    layout.rowPointer = pointer
    layout.height = pointer.y2 + 4
  }
  return layout
}

/**
 * One level: the pages the search went through on it, linked to the
 * parent's pointer: left to right, or for a backward scan, which moves left
 * along the leaves, right to left.
 */
function layoutRow(
  input: LayoutInput,
  steps: PathStep[],
  y: number,
  parent: { shape: PageShape; step: PathStep; contents: IndexPageContents } | null,
) {
  const { pages, width } = input
  const contents = steps.map((step) => pages.get(step.page.block))
  if (contents.some((page) => page === undefined)) return null
  const all = contents as IndexPageContents[]

  // Earlier pages on the level are drawn small; at most the first and the one before the last, with a count between.
  const lastIndex = steps.length - 1
  const shownEarlier = lastIndex <= 2 ? [...Array(lastIndex).keys()] : [0, lastIndex - 1]
  const skipped = lastIndex - shownEarlier.length
  const compacts = shownEarlier.map((i) => compactPage(all[i], steps[i], input))
  const skippedWidth = skipped > 0 ? textWidth(`+${skipped}`) + ROW_SPACE : 0
  const earlierWidth = compacts.reduce((sum, shape) => sum + shape.width + ROW_SPACE, 0) + skippedWidth
  // Room for the boxes standing for the parent's other children: kept free unless the page would get too narrow.
  const backward = input.view.backward
  const counts = parent ? siblingCounts(parent, steps.length, backward) : { left: 0, right: 0 }
  const leftRoom = counts.left > 0 ? textWidth(pagesText(counts.left)) + ROW_SPACE : 0
  const rightRoom = counts.right > 0 ? textWidth(pagesText(counts.right)) + ROW_SPACE : 0
  const available = width - 2 * MARGIN - earlierWidth
  const withRoom = available - leftRoom - rightRoom
  const full = fullPage(all[lastIndex], steps[lastIndex], input, withRoom >= MIN_PAGE_WIDTH ? withRoom : available)

  // The page read first sits under the parent's pointer, as far as the width allows.
  // A backward scan's row is laid out left to right, then mirrored: its first page ends up on the right.
  const rowWidth = earlierWidth + full.width
  const first = compacts[0] ?? full
  const firstCenter = backward ? rowWidth - first.width / 2 : first.width / 2
  const pointerX = parent ? parent.shape.x + followedGapCenter(parent.shape) : width / 2
  const fits = leftRoom + rowWidth + rightRoom <= width - 2 * MARGIN
  const start = fits
    ? clamp(pointerX - firstCenter, MARGIN + leftRoom, width - MARGIN - rowWidth - rightRoom)
    : clamp(pointerX - firstCenter, MARGIN, width - MARGIN - rowWidth)

  const shapes: PageShape[] = []
  const links: LinkShape[] = []
  const ghosts: GhostShape[] = []
  // Left edges of everything on the row, pages and the count of skipped ones, for the arrows between them.
  const boxes: { x: number; width: number }[] = []
  let x = start
  compacts.forEach((shape, i) => {
    shapes.push({ ...shape, x, y })
    boxes.push({ x, width: shape.width })
    x += shape.width + ROW_SPACE
    if (i === 0 && skipped > 0) {
      const text = `+${skipped}`
      ghosts.push({ x, y, width: textWidth(text), text })
      boxes.push({ x, width: textWidth(text) })
      x += skippedWidth
    }
  })
  shapes.push({ ...full, x, y })
  boxes.push({ x, width: full.width })
  // Arrows between neighbors on the level, from each page to the next one read.
  for (let i = 1; i < boxes.length; i++) {
    const left = boxes[i - 1]
    links.push({ x1: left.x + left.width, y1: y + NODE_HEIGHT / 2, x2: boxes[i].x, y2: y + NODE_HEIGHT / 2, kind: 'right' })
  }
  if (backward) {
    // Mirror the row within its span: x becomes start + rowWidth - (x - start).
    const mirror = (at: number) => 2 * start + rowWidth - at
    for (const shape of shapes) shape.x = mirror(shape.x + shape.width)
    for (const ghost of ghosts) ghost.x = mirror(ghost.x + ghost.width)
    for (const link of links) {
      link.x1 = mirror(link.x1)
      link.x2 = mirror(link.x2)
      link.kind = 'left'
    }
  }

  if (parent) {
    const gap = followedGapCenter(parent.shape)
    const top = parent.shape.y + NODE_HEIGHT
    links.push({ x1: parent.shape.x + gap, y1: top, x2: shapes[0].x + shapes[0].width / 2, y2: y, kind: 'down' })
    ghosts.push(...siblingGhosts(parent, shapes, steps.length, y, width, links))
  }
  const last = shapes[shapes.length - 1]
  return {
    shapes,
    links,
    ghosts,
    last: { shape: last, step: steps[lastIndex], contents: all[lastIndex] },
    skipped,
  }
}

/** The parent's other children (siblingCounts), as a faint box each side with how many there are, when they fit. */
function siblingGhosts(
  parent: { shape: PageShape; step: PathStep; contents: IndexPageContents },
  shapes: PageShape[],
  visited: number,
  y: number,
  width: number,
  links: LinkShape[],
): GhostShape[] {
  const backward = shapes.length > 1 && shapes[0].x > shapes[shapes.length - 1].x
  const { left, right } = siblingCounts(parent, visited, backward)
  if (left === 0 && right === 0) return []
  const ghosts: GhostShape[] = []
  const top = parent.shape.y + NODE_HEIGHT
  const leftmost = Math.min(...shapes.map((shape) => shape.x))
  const rightmost = Math.max(...shapes.map((shape) => shape.x + shape.width))
  if (left > 0) {
    const text = pagesText(left)
    const ghostWidth = textWidth(text)
    const x = leftmost - ROW_SPACE - ghostWidth
    if (x >= MARGIN - EPSILON) {
      ghosts.push({ x, y, width: ghostWidth, text })
      links.push({ x1: parent.shape.x + gapCenterBefore(parent.shape), y1: top, x2: x + ghostWidth / 2, y2: y, kind: 'sibling' })
    }
  }
  if (right > 0) {
    const text = pagesText(right)
    const ghostWidth = textWidth(text)
    const x = rightmost + ROW_SPACE
    if (x + ghostWidth <= width - MARGIN + EPSILON) {
      ghosts.push({ x, y, width: ghostWidth, text })
      links.push({ x1: parent.shape.x + gapCenterAfter(parent.shape), y1: top, x2: x + ghostWidth / 2, y2: y, kind: 'sibling' })
    }
  }
  return ghosts
}

/**
 * How many other children the parent has left and right of the one the
 * search went to. After moving right along a level (left, for a backward
 * scan), the pages that way may belong to another parent, so that count is
 * only given when the search stayed on one page.
 */
function siblingCounts(parent: { step: PathStep; contents: IndexPageContents }, visited: number, backward: boolean) {
  const items = parent.contents.items
  const followed = items.findIndex((item) => item.offset === parent.step.downlink)
  if (followed < 0) return { left: 0, right: 0 }
  const left = followed
  const right = items.length - 1 - followed
  if (visited === 1) return { left, right }
  return backward ? { left: 0, right } : { left, right: 0 }
}

function pagesText(count: number) {
  return `${integer.format(count)} ${count === 1 ? 'page' : 'pages'}`
}

/** A page drawn in full: its keys around the one in focus, as many as fit in `budget`. */
function fullPage(contents: IndexPageContents, step: PathStep, input: LayoutInput, budget: number): PageShape {
  const highKey = input.highKeys ? highKeyCell(contents, input.keyColumns) : null
  const room = budget - (highKey?.width ?? 0)
  const cells = contents.level === 0 ? leafCells(contents, input, room) : innerCells(contents, step, input, room)
  if (highKey) {
    const end = cells.reduce((sum, cell) => sum + cell.width, 0)
    cells.push({ ...highKey, x: end })
  }
  return {
    block: contents.block,
    x: 0,
    y: 0,
    width: cells.reduce((sum, cell) => sum + cell.width, 0),
    label: pageLabel(contents),
    current: isCurrent(contents, input.current),
    compact: false,
    cells,
  }
}

/** An earlier page on a level, small: its first and last keys. */
function compactPage(contents: IndexPageContents, step: PathStep, input: LayoutInput): PageShape {
  const keys = contents.level === 0 ? contents.items : contents.items.slice(1)
  const first = keys[0]
  const last = keys[keys.length - 1]
  const text =
    first === undefined
      ? '…'
      : first === last
        ? short(formatIndexKey(first.key, input.keyColumns))
        : `${short(formatIndexKey(first.key, input.keyColumns))} … ${short(formatIndexKey(last.key, input.keyColumns))}`
  const width = textWidth(text)
  return {
    block: contents.block,
    x: 0,
    y: 0,
    width,
    label: `idx p${contents.block}`,
    current: isCurrent(contents, input.current),
    compact: true,
    cells: [{ kind: 'ellipsis', x: 0, width, text, title: null, mark: null, offset: step.downlink }],
  }
}

/**
 * A page above the leaves, as a textbook draws it: the keys that separate
 * its children, with a pointer in each gap. Postgres stores each child's
 * pointer with the lowest key it can hold (the first one with none: minus
 * infinity), so the pointer in the gap after a key is the downlink with that
 * key, and the gap before the first key is the first downlink.
 */
function innerCells(contents: IndexPageContents, step: PathStep, input: LayoutInput, budget: number): Cell[] {
  const items = contents.items
  const followed = Math.max(0, items.findIndex((item) => item.offset === step.downlink))
  const gaps = items.length
  // Gaps lo..hi are shown, with the keys between them (key j sits between gaps j - 1 and j).
  const build = (lo: number, hi: number) => {
    const cells: Omit<Cell, 'x'>[] = []
    if (lo > 0) cells.push(ellipsis(lo))
    for (let gap = lo; gap <= hi; gap++) {
      if (gap > lo) cells.push(keyCell(items[gap].key, input.keyColumns, null, items[gap].offset))
      cells.push({
        kind: 'gap',
        width: GAP_WIDTH,
        text: '',
        title: `→ idx p${items[gap].child}`,
        mark: step.downlink !== null && gap === followed ? 'followed' : null,
        offset: items[gap].offset,
      })
    }
    if (hi < gaps - 1) cells.push(ellipsis(gaps - 1 - hi))
    return cells
  }
  return fitAround(followed, gaps, build, budget)
}

/** A leaf: its entries around the one in focus (matching now, else the latest match), marked. */
function leafCells(contents: IndexPageContents, input: LayoutInput, budget: number): Cell[] {
  const { view, currentEntry, keyColumns } = input
  const items = contents.items
  const focusOffset = currentEntry ?? view.matchedOffsets.at(-1) ?? null
  const focus = Math.max(0, focusOffset === null ? 0 : items.findIndex((item) => item.offset === focusOffset))
  const matched = new Set(view.matchedOffsets)
  const mark = (index: number): Mark | null => {
    const item = items[index]
    if (view.deadEntries.has(`${contents.block}/${item.offset}`)) return 'markedDead'
    if (item.offset === currentEntry) return 'current'
    if (matched.has(item.offset)) return 'matched'
    return item.dead ? 'dead' : null
  }
  const build = (lo: number, hi: number) => {
    const cells: Omit<Cell, 'x'>[] = []
    if (lo > 0) cells.push(ellipsis(lo))
    for (let i = lo; i <= hi; i++) cells.push(keyCell(items[i].key, keyColumns, mark(i), items[i].offset))
    if (hi < items.length - 1) cells.push(ellipsis(items.length - 1 - hi))
    return cells
  }
  if (items.length === 0) return place([ellipsis(0)])
  return fitAround(focus, items.length, build, budget)
}

/**
 * The widest window of positions around `focus` (up to AROUND each side,
 * more on one side at an edge) whose cells fit in `budget`; the focus alone
 * if nothing else fits.
 */
function fitAround(
  focus: number,
  count: number,
  build: (lo: number, hi: number) => Omit<Cell, 'x'>[],
  budget: number,
): Cell[] {
  for (let around = AROUND; around >= 0; around--) {
    let lo = Math.max(0, focus - around)
    let hi = Math.min(count - 1, focus + around)
    // At an edge, use the room on the other side.
    const want = 2 * around + 1
    if (hi - lo + 1 < want) {
      if (lo === 0) hi = Math.min(count - 1, lo + want - 1)
      else lo = Math.max(0, hi - want + 1)
    }
    const cells = build(lo, hi)
    if (around === 0 || cells.reduce((sum, cell) => sum + cell.width, 0) <= budget) return place(cells)
  }
  return []
}

/** Gives each cell its x, left to right. */
function place(cells: Omit<Cell, 'x'>[]): Cell[] {
  let x = 0
  return cells.map((cell) => {
    const placed = { ...cell, x }
    x += cell.width
    return placed
  })
}

function keyCell(key: (string | null)[], keyColumns: number, mark: Mark | null, offset: number): Omit<Cell, 'x'> {
  const full = formatIndexKey(key, keyColumns)
  const text = short(full)
  return { kind: 'key', width: textWidth(text), text, title: text === full ? null : full, mark, offset }
}

/**
 * The page's high key, the upper bound of its keys: "HK 4300". The rightmost
 * page of a level has none, so no upper bound: "HK +∞".
 */
function highKeyCell(contents: IndexPageContents, keyColumns: number): Omit<Cell, 'x'> {
  if (contents.highKey === null) {
    const text = 'HK +∞'
    return { kind: 'highKey', width: textWidth(text), text, title: 'No high key: the rightmost page on its level has no upper bound', mark: null, offset: null }
  }
  const full = formatIndexKey(contents.highKey, keyColumns)
  const text = `HK ${short(full)}`
  return { kind: 'highKey', width: textWidth(text), text, title: `High key ${full}: every key on this page sorts at or below it`, mark: null, offset: 1 }
}

function ellipsis(hidden: number): Omit<Cell, 'x'> {
  const text = hidden > 0 ? `…${integer.format(hidden)}…` : '…'
  return { kind: 'ellipsis', width: textWidth(text), text, title: hidden > 0 ? `${integer.format(hidden)} more` : null, mark: null, offset: null }
}

/** The middle of the gap the search followed down from, relative to the page. */
function followedGapCenter(shape: PageShape): number {
  const gap = shape.cells.find((cell) => cell.mark === 'followed') ?? shape.cells.find((cell) => cell.kind === 'gap')
  return gap ? gap.x + gap.width / 2 : shape.width / 2
}

/** Where the pointers to the children left of the followed one start: the gap before it, or the "…" for the ones not shown. */
function gapCenterBefore(shape: PageShape): number {
  const index = shape.cells.findIndex((cell) => cell.mark === 'followed')
  const before = shape.cells.slice(0, Math.max(0, index)).reverse().find((cell) => cell.kind === 'gap' || cell.kind === 'ellipsis')
  return before ? before.x + before.width / 2 : 0
}

/** Where the pointers to the children right of the followed one start. */
function gapCenterAfter(shape: PageShape): number {
  const index = shape.cells.findIndex((cell) => cell.mark === 'followed')
  const after = shape.cells.slice(index + 1).find((cell) => cell.kind === 'gap' || cell.kind === 'ellipsis')
  return after ? after.x + after.width / 2 : shape.width
}

/**
 * A line down from the latest matched entry on the current leaf to the heap
 * row it points at, or to the bitmap that row is marked in.
 */
function rowPointer(input: LayoutInput, layout: BtreeLayout): RowPointer | null {
  const latest = input.view.entries.at(-1)
  const leaf = layout.pages.at(-1)
  if (latest === undefined || leaf === undefined || leaf.compact || input.view.leaf?.block !== leaf.block) return null
  const cell = leaf.cells.find((each) => each.kind === 'key' && each.offset === latest.offset)
  if (cell === undefined) return null
  const y1 = leaf.y + NODE_HEIGHT
  const x = leaf.x + cell.x + cell.width / 2
  if (latest.bitmap) return { x, y1, y2: y1 + 26, text: `bitmap: row ${rowName(latest.row)}`, kind: 'bitmap' }
  return { x, y1, y2: y1 + 26, text: `heap row ${rowName(latest.row)}`, kind: 'heap' }
}

function pageLabel(contents: IndexPageContents): string {
  if (contents.isRoot) return `idx p${contents.block} · root`
  if (contents.level === 0) return `idx p${contents.block} · leaf`
  return `idx p${contents.block} · level ${contents.level}`
}

function isCurrent(contents: IndexPageContents, current: PageRef | null) {
  return current !== null && current.relation === contents.relation && current.block === contents.block
}

/** A key's text, cut to MAX_KEY_CHARS. */
function short(text: string): string {
  return text.length <= MAX_KEY_CHARS ? text : `${text.slice(0, MAX_KEY_CHARS - 1)}…`
}

/** The width of a cell holding this text. */
export function textWidth(text: string): number {
  return text.length * CHAR_WIDTH + KEY_PADDING
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(value, Math.max(low, high)))
}
