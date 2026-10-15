import type { BufferSlot, PageMark } from '../player/playback'
import { pageName } from '../player/playback'
import type { TraceRelation } from '../replay/trace'

/*
 * What hovering (or focusing) a buffer slot or a heap mini-map square says
 * (docs/UX.md#visualization). Every value comes from the playback state at
 * the step on screen: the slot's page and its hits and reads, and each heap
 * page's mark.
 */

const integer = new Intl.NumberFormat('en-US')

function times(count: number): string {
  return count === 1 ? 'once' : count === 2 ? 'twice' : `${integer.format(count)} times`
}

/**
 * A buffer slot's hover text: "heap page 212 of orders. Read from disk into
 * shared buffers by this query. Asked for 3 times so far: 1 read from disk,
 * 2 hits."
 */
export function describeSlot(slot: BufferSlot, relations: Map<number, TraceRelation>): string {
  const relation = relations.get(slot.page.relation)
  const name = relation === undefined ? pageName(slot.page, relations) : `${pageName(slot.page, relations)} of ${relation.name}`
  const sentences = [
    slot.wasCached
      ? `${capitalize(name)}. It was already in shared buffers when the query first asked for it: a hit.`
      : `${capitalize(name)}. It wasn’t in shared buffers, so this query read it from disk into a buffer.`,
  ]
  const accesses = slot.hits + slot.reads
  if (accesses > 1) {
    const parts = []
    if (slot.reads > 0) parts.push(`${integer.format(slot.reads)} ${slot.reads === 1 ? 'read' : 'reads'} from disk`)
    if (slot.hits > 0) parts.push(`${integer.format(slot.hits)} ${slot.hits === 1 ? 'hit' : 'hits'}`)
    sentences.push(`Asked for ${times(accesses)} so far: ${parts.join(', ')}.`)
  }
  if (slot.ahead) sentences.push('Asked for ahead of the scan, which a Limit stopped before it got there.')
  return sentences.join(' ')
}

/** What a heap page's mark says about it, as the hover text words it. */
const MARK_WORDS: Record<PageMark | 'none', string> = {
  none: 'not read so far',
  touched: 'read, no rows to the result so far',
  result: 'read, gave rows to the result',
  fromIndex: 'all-visible, so the index-only scan took its rows from the index without reading it',
  bitmap: 'marked in the bitmap, not read yet',
  ahead: 'read ahead of the scan, which a Limit stopped before it got there',
}

/** The order the marks are listed in for a square of several pages. */
const MARK_ORDER: (PageMark | 'none')[] = ['result', 'touched', 'fromIndex', 'bitmap', 'ahead', 'none']

/** A mini-map square: its name ("heap page 37", "heap pages 1,200 to 1,201") and what its pages went through. */
export interface SquareInfo {
  label: string
  detail: string
}

/**
 * A heap mini-map square's hover text. A square of several pages (a table of
 * more than 600) counts its pages by mark, rather than naming the one mark it
 * shows.
 */
export function describeSquare(cell: number, perCell: number, pages: number, marks: Map<number, PageMark>, current: number | null): SquareInfo {
  const first = cell * perCell
  const last = Math.min(pages, first + perCell) - 1
  const label = squareLabel(cell, perCell, pages)
  const counts = new Map<PageMark | 'none', number>()
  for (let block = first; block <= last; block++) {
    const mark = marks.get(block) ?? 'none'
    counts.set(mark, (counts.get(mark) ?? 0) + 1)
  }
  let detail: string
  if (first === last) {
    detail = `${capitalize(label)}: ${MARK_WORDS[marks.get(first) ?? 'none']}.`
  } else {
    const parts = MARK_ORDER.filter((mark) => counts.has(mark)).map((mark) => {
      const count = counts.get(mark) ?? 0
      return `${integer.format(count)} ${MARK_WORDS[mark]}`
    })
    detail = `${capitalize(label)}: ${parts.join('; ')}.`
  }
  if (current !== null && current >= first && current <= last) {
    detail += first === last ? ' Being read now.' : ` Heap page ${integer.format(current)} is being read now.`
  }
  return { label, detail }
}

/** A mini-map square's name: "heap page 37", or "heap pages 1,200 to 1,201" for a square of several. */
export function squareLabel(cell: number, perCell: number, pages: number): string {
  const first = cell * perCell
  const last = Math.min(pages, first + perCell) - 1
  return first === last ? `heap page ${integer.format(first)}` : `heap pages ${integer.format(first)} to ${integer.format(last)}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
