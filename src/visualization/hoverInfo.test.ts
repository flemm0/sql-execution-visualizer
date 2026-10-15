import { describe, expect, it } from 'vitest'
import type { BufferSlot, PageMark } from '../player/playback'
import type { TraceRelation } from '../replay/trace'
import { describeSlot, describeSquare, squareLabel } from './hoverInfo'

const TABLE = 10
const INDEX = 20
const relations = new Map<number, TraceRelation>([
  [TABLE, { id: TABLE, name: 'orders', kind: 'table', pages: 1278 }],
  [INDEX, { id: INDEX, name: 'orders_pkey', kind: 'index', pages: 30 }],
])

function slot(fields: Partial<BufferSlot>): BufferSlot {
  return { page: { relation: TABLE, block: 212 }, wasCached: false, ahead: false, hits: 0, reads: 1, ...fields }
}

describe('describeSlot', () => {
  it('names the page in full and says whether it was a read or a hit', () => {
    expect(describeSlot(slot({}), relations)).toBe(
      'Heap page 212 of orders. It wasn’t in shared buffers, so this query read it from disk into a buffer.',
    )
    expect(describeSlot(slot({ page: { relation: INDEX, block: 57 }, wasCached: true, hits: 1, reads: 0 }), relations)).toBe(
      'Index page 57 of orders_pkey. It was already in shared buffers when the query first asked for it: a hit.',
    )
    expect(describeSlot(slot({ page: { relation: TABLE, block: 0, fork: 'vm' }, wasCached: true, hits: 1, reads: 0 }), relations)).toMatch(
      /^Visibility map page 0 of orders\./,
    )
  })

  it('counts the times the query asked for a page more than once, hits and reads', () => {
    expect(describeSlot(slot({ hits: 1, reads: 1 }), relations)).toBe(
      'Heap page 212 of orders. It wasn’t in shared buffers, so this query read it from disk into a buffer. Asked for twice so far: 1 read from disk, 1 hit.',
    )
    expect(describeSlot(slot({ wasCached: true, hits: 4, reads: 0 }), relations)).toMatch(/Asked for 4 times so far: 4 hits\.$/)
  })

  it('says when the page was asked for ahead of a scan a Limit stopped', () => {
    expect(describeSlot(slot({ ahead: true }), relations)).toMatch(/Asked for ahead of the scan, which a Limit stopped before it got there\.$/)
  })
})

describe('describeSquare', () => {
  const marks = new Map<number, PageMark>([
    [0, 'result'],
    [1, 'touched'],
    [2, 'touched'],
    [4, 'fromIndex'],
    [5, 'bitmap'],
    [6, 'ahead'],
  ])

  it('says what one page went through', () => {
    expect(describeSquare(0, 1, 10, marks, null).detail).toBe('Heap page 0: read, gave rows to the result.')
    expect(describeSquare(1, 1, 10, marks, null).detail).toBe('Heap page 1: read, no rows to the result so far.')
    expect(describeSquare(3, 1, 10, marks, null).detail).toBe('Heap page 3: not read so far.')
    expect(describeSquare(4, 1, 10, marks, null).detail).toBe(
      'Heap page 4: all-visible, so the index-only scan took its rows from the index without reading it.',
    )
    expect(describeSquare(5, 1, 10, marks, null).detail).toBe('Heap page 5: marked in the bitmap, not read yet.')
    expect(describeSquare(6, 1, 10, marks, null).detail).toBe('Heap page 6: read ahead of the scan, which a Limit stopped before it got there.')
    expect(describeSquare(2, 1, 10, marks, 2).detail).toBe('Heap page 2: read, no rows to the result so far. Being read now.')
  })

  it('counts the pages of a square that stands for several, by what they went through', () => {
    expect(describeSquare(0, 3, 10, marks, 1)).toEqual({
      label: 'heap pages 0 to 2',
      detail: 'Heap pages 0 to 2: 1 read, gave rows to the result; 2 read, no rows to the result so far. Heap page 1 is being read now.',
    })
    // The last square holds only the pages left.
    expect(squareLabel(3, 3, 10)).toBe('heap page 9')
    expect(squareLabel(1, 600, 1278)).toBe('heap pages 600 to 1,199')
  })
})
