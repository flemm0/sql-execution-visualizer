import { describe, expect, it } from 'vitest'
import type { IndexView } from '../player/playback'
import type { IndexPageContents } from '../replay/trace'
import { NODE_HEIGHT, layoutBtree, type LayoutInput } from './btreeLayout'

const INDEX = 20

/** A root with downlinks to pages 100, 101, ...: the first keyless (minus infinity), then keys 10, 20, ... */
function root(children: number): IndexPageContents {
  return {
    relation: INDEX,
    block: 3,
    level: 1,
    isRoot: true,
    next: null,
    highKey: null,
    items: Array.from({ length: children }, (_, i) => ({
      offset: i + 1,
      key: i === 0 ? [] : [String(i * 10)],
      child: 100 + i,
      rows: 0,
      dead: false,
    })),
  }
}

/** A leaf with entries first, first + 1, ... */
function leaf(block: number, first: number, count: number): IndexPageContents {
  return {
    relation: INDEX,
    block,
    level: 0,
    isRoot: false,
    next: block + 1,
    highKey: [String(first + count)],
    items: Array.from({ length: count }, (_, i) => ({ offset: i + 2, key: [String(first + i)], child: null, rows: 1, dead: false })),
  }
}

function view(path: IndexView['path'], matchedOffsets: number[] = [], backward = false): IndexView {
  return {
    index: { id: INDEX, name: 'orders_pkey', kind: 'index', pages: 200 },
    backward,
    searches: 1,
    path,
    leaf: path.at(-1)?.level === 0 ? (path.at(-1)?.page ?? null) : null,
    entries: matchedOffsets.map((offset) => ({ offset, key: [], row: { relation: 10, block: 50, offset: 3 }, bitmap: false })),
    entryCount: matchedOffsets.length,
    matchedOffsets,
    markedDead: 0,
    deadEntries: new Set(),
  }
}

function input(overrides: Partial<LayoutInput> & Pick<LayoutInput, 'view' | 'pages'>): LayoutInput {
  return { keyColumns: 1, current: null, currentEntry: null, width: 520, ...overrides }
}

const page = (block: number) => ({ relation: INDEX, block })

describe('laying out the B-tree', () => {
  // Example 1's shape: a root of 30 downlinks, the search follows the 13th (key 120) to leaf 112.
  const pages = new Map([
    [3, root(30)],
    [112, leaf(112, 4240, 300)],
  ])
  const walked = view(
    [
      { page: page(3), level: 1, downlink: 13 },
      { page: page(112), level: 0, downlink: null },
    ],
    [4],
  )

  it('draws the root as keys with a pointer in each gap, the followed one in the gap after its key', () => {
    const layout = layoutBtree(input({ view: walked, pages, currentEntry: 4 }))
    const [top] = layout.pages
    expect(top).toMatchObject({ block: 3, label: 'idx p3 · root', compact: false })
    // Downlink 13 holds key 120: the pointer to page 112 is the gap right after 120.
    const followed = top.cells.findIndex((cell) => cell.mark === 'followed')
    expect(top.cells[followed]).toMatchObject({ kind: 'gap', offset: 13, title: '→ idx p112' })
    expect(top.cells[followed - 1]).toMatchObject({ kind: 'key', text: '120' })
    expect(top.cells[followed + 1]).toMatchObject({ kind: 'key', text: '130' })
    // Keys and gaps alternate, with "…" and a count for what's left out at each end.
    const kinds = top.cells.map((cell) => cell.kind)
    expect(kinds[0]).toBe('ellipsis')
    expect(kinds.at(-1)).toBe('ellipsis')
    expect(kinds.slice(1, -1).every((kind, i) => kind === (i % 2 === 0 ? 'gap' : 'key'))).toBe(true)
    expect(top.cells[0].text).toBe(`…${top.cells[1].offset as number - 1}…`)
  })

  it('links the followed pointer down to the child, and the other children as counted boxes', () => {
    const layout = layoutBtree(input({ view: walked, pages, currentEntry: 4 }))
    const [top, child] = layout.pages
    const followed = top.cells.find((cell) => cell.mark === 'followed')
    if (followed === undefined) throw new Error('no followed gap')
    const [down] = layout.links.filter((link) => link.kind === 'down')
    expect(down).toEqual({
      x1: top.x + followed.x + followed.width / 2,
      y1: top.y + NODE_HEIGHT,
      x2: child.x + child.width / 2,
      y2: child.y,
      kind: 'down',
    })
    // 12 children left of the followed one, 17 right.
    expect(layout.ghosts.map((ghost) => ghost.text)).toEqual(['12 pages', '17 pages'])
    expect(layout.links.filter((link) => link.kind === 'sibling')).toHaveLength(2)
    const [left, right] = layout.ghosts
    expect(left.x + left.width).toBeLessThan(child.x)
    expect(right.x).toBeGreaterThan(child.x + child.width)
    expect(right.x + right.width).toBeLessThanOrEqual(520)
  })

  it('draws the leaf around the entry matching now, and points it at its heap row', () => {
    const layout = layoutBtree(input({ view: walked, pages, currentEntry: 4, current: page(112) }))
    const child = layout.pages[1]
    expect(child).toMatchObject({ label: 'idx p112 · leaf', current: true })
    const keys = child.cells.filter((cell) => cell.kind === 'key')
    expect(keys.map((cell) => cell.text)).toEqual(['4240', '4241', '4242', '4243', '4244', '4245', '4246'])
    expect(keys.find((cell) => cell.mark === 'current')?.text).toBe('4242')
    expect(child.cells.at(-1)).toMatchObject({ kind: 'ellipsis', text: '…293…' })
    const current = keys[2]
    expect(layout.rowPointer).toMatchObject({ x: child.x + current.x + current.width / 2, text: 'heap row (50,3)', kind: 'heap' })
  })

  it('points a bitmap index scan’s match into the bitmap, not at the heap', () => {
    const marking = { ...walked, entries: walked.entries.map((entry) => ({ ...entry, bitmap: true })) }
    const layout = layoutBtree(input({ view: marking, pages, currentEntry: 4, current: page(112) }))
    expect(layout.rowPointer).toMatchObject({ text: 'bitmap: row (50,3)', kind: 'bitmap' })
  })

  it('shows fewer keys when the width is short, never fewer than the one in focus', () => {
    const wide = layoutBtree(input({ view: walked, pages, width: 520 }))
    const narrow = layoutBtree(input({ view: walked, pages, width: 260 }))
    const count = (layout: typeof wide) => layout.pages[0].cells.filter((cell) => cell.kind === 'key').length
    expect(count(narrow)).toBeLessThan(count(wide))
    expect(narrow.pages[0].cells.some((cell) => cell.mark === 'followed')).toBe(true)
    for (const shape of narrow.pages) expect(shape.x + shape.width).toBeLessThanOrEqual(260)
  })

  it('lays the leaves a scan moved right along side by side, earlier ones small, linked left to right', () => {
    const leaves = new Map([
      [3, root(30)],
      [101, leaf(101, 10, 300)],
      [102, leaf(102, 310, 300)],
      [103, leaf(103, 610, 300)],
      [104, leaf(104, 910, 300)],
    ])
    const moved = view(
      [
        { page: page(3), level: 1, downlink: 2 },
        { page: page(101), level: 0, downlink: null },
        { page: page(102), level: 0, downlink: null },
        { page: page(103), level: 0, downlink: null },
        { page: page(104), level: 0, downlink: null },
      ],
      [2, 3],
    )
    const layout = layoutBtree(input({ view: moved, pages: leaves }))
    const row = layout.pages.slice(1)
    // The first and the one before the last, small, with a count for the one between; the last in full.
    expect(row.map((shape) => [shape.block, shape.compact])).toEqual([
      [101, true],
      [103, true],
      [104, false],
    ])
    expect(row[0].cells[0].text).toBe('10 … 309')
    expect(layout.ghosts.map((ghost) => ghost.text)).toContain('+1')
    expect(layout.links.filter((link) => link.kind === 'right')).toHaveLength(3)
    // The followed pointer leads to the first leaf; there's 1 child left of it; the right count is unknown.
    const down = layout.links.find((link) => link.kind === 'down')
    expect(down?.x2).toBe(row[0].x + row[0].width / 2)
    expect(layout.ghosts.map((ghost) => ghost.text)).toContain('1 page')
    expect(layout.ghosts.some((ghost) => ghost.text.endsWith('pages') && ghost.text !== '1 page')).toBe(false)
  })

  it('lays the leaves a backward scan moved left along right to left, the last read on the left, linked right to left', () => {
    const leaves = new Map([
      [3, root(30)],
      [101, leaf(101, 10, 300)],
      [102, leaf(102, 310, 300)],
      [103, leaf(103, 610, 300)],
      [104, leaf(104, 910, 300)],
    ])
    const moved = view(
      [
        { page: page(3), level: 1, downlink: 5 },
        { page: page(104), level: 0, downlink: null },
        { page: page(103), level: 0, downlink: null },
        { page: page(102), level: 0, downlink: null },
        { page: page(101), level: 0, downlink: null },
      ],
      [2, 3],
      true,
    )
    // Wide enough for the count of pages right of the first leaf.
    const layout = layoutBtree(input({ view: moved, pages: leaves, width: 700 }))
    const row = layout.pages.slice(1)
    // In the order read: the first and the one before the last small, the last in full; on screen, right to left.
    expect(row.map((shape) => [shape.block, shape.compact])).toEqual([
      [104, true],
      [102, true],
      [101, false],
    ])
    expect(row[2].x).toBeLessThan(row[1].x)
    expect(row[1].x).toBeLessThan(row[0].x)
    // Arrows point left, from each page to the next one read.
    const arrows = layout.links.filter((link) => link.kind === 'left')
    expect(arrows).toHaveLength(3)
    expect(arrows.every((link) => link.x2 < link.x1)).toBe(true)
    // The followed pointer leads to the first leaf read, now on the right; the count to its right is known, to its left not.
    const down = layout.links.find((link) => link.kind === 'down')
    expect(down?.x2).toBe(row[0].x + row[0].width / 2)
    expect(layout.ghosts.map((ghost) => ghost.text)).toContain('25 pages')
    expect(layout.ghosts.some((ghost) => ghost.text === '4 pages')).toBe(false)
  })

  it('marks entries dead, matched earlier, or marked dead by this scan', () => {
    const contents = leaf(112, 1, 5)
    contents.items[0].dead = true
    const marked = view([{ page: page(112), level: 0, downlink: null }], [3, 4])
    marked.deadEntries.add('112/5')
    const layout = layoutBtree(input({ view: marked, pages: new Map([[112, contents]]), currentEntry: 4 }))
    expect(layout.pages[0].cells.map((cell) => [cell.text, cell.mark])).toEqual([
      ['1', 'dead'],
      ['2', 'matched'],
      ['3', 'current'],
      ['4', 'markedDead'],
      ['5', null],
    ])
  })

  it('writes dropped key columns as minus infinity, and cuts long keys', () => {
    const contents = root(3)
    contents.items[1].key = ['777']
    contents.items[2].key = ['Bartholomew-Fitzgerald', 'x']
    const layout = layoutBtree(
      input({ view: view([{ page: page(3), level: 1, downlink: 1 }]), pages: new Map([[3, contents]]), keyColumns: 2 }),
    )
    const keys = layout.pages[0].cells.filter((cell) => cell.kind === 'key')
    expect(keys.map((cell) => cell.text)).toEqual(['(777, −∞)', '(Bartholomew-Fi…'])
    expect(keys[1].title).toBe('(Bartholomew-Fitzgerald, x)')
  })

  it('stacks every level of a 3-level index, each linked from the pointer followed, with its other pages counted', () => {
    // Like order_items_pkey: a root with 2 children, a level-1 page with a high key (items from offset 2), a leaf.
    const page1 = (block: number, level: number, count: number, isRoot: boolean): IndexPageContents => ({
      relation: INDEX,
      block,
      level,
      isRoot,
      next: isRoot ? null : block + 1,
      highKey: isRoot ? null : ['999', '1'],
      items: Array.from({ length: count }, (_, i) => ({
        offset: i + (isRoot ? 1 : 2),
        key: i === 0 && level > 0 ? [] : [String(700 + i), '1'],
        child: level > 0 ? 500 + i : null,
        rows: level > 0 ? 0 : 1,
        dead: false,
      })),
    })
    const pages3 = new Map([
      [290, page1(290, 2, 2, true)],
      [3, page1(3, 1, 284, false)],
      [10, page1(10, 0, 366, false)],
    ])
    const walked3 = view(
      [
        { page: page(290), level: 2, downlink: 1 },
        { page: page(3), level: 1, downlink: 10 },
        { page: page(10), level: 0, downlink: null },
      ],
      [180],
    )
    const layout = layoutBtree(input({ view: walked3, pages: pages3, keyColumns: 2, currentEntry: 180, width: 522 }))
    expect(layout.pages.map((shape) => shape.label)).toEqual(['idx p290 · root', 'idx p3 · level 1', 'idx p10 · leaf'])
    expect(new Set(layout.pages.map((shape) => shape.y)).size).toBe(3)
    // Down from the root's first pointer to page 3, then from page 3's pointer at offset 10 (its 9th item) to the leaf.
    const downs = layout.links.filter((link) => link.kind === 'down')
    expect(downs).toHaveLength(2)
    expect(layout.pages[0].cells.find((cell) => cell.mark === 'followed')?.offset).toBe(1)
    expect(layout.pages[1].cells.find((cell) => cell.mark === 'followed')?.offset).toBe(10)
    // 1 page right of page 3; 8 left and 275 right of the leaf, even when the left box lands right at the margin.
    expect(layout.ghosts.map((ghost) => ghost.text)).toEqual(['1 page', '8 pages', '275 pages'])
    for (const ghost of layout.ghosts) {
      expect(ghost.x).toBeGreaterThanOrEqual(0)
      expect(ghost.x + ghost.width).toBeLessThanOrEqual(522)
    }
  })
})
