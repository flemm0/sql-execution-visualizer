import type { PGliteInterface } from '@electric-sql/pglite'
import { readHeapItems, readHeapPageHeaders, readVisibilityMap, type HeapItem, type Relation, type Tid } from '../db/inspector'
import { MAX_TRACED_ROWS, type HeapPageContents, type LinePointer, type TraceEvent } from './trace'

/*
 * The internals of the heap pages a trace shows, for "Show internals"
 * (docs/UX.md): each page's header and visibility map bits, and the line
 * pointer and tuple header of each row the events name. Read with
 * pageinspect after the query ran, for those pages and rows only: reading
 * every line pointer of a big table would cost seconds (ADR 0039).
 */

/**
 * Reads the internals of the table's heap pages that the events show: the
 * pages the query read (a buffer hit or read), and the pages an index-only
 * scan skipped because they're all-visible, which get their visibility map
 * bits only. Three or four queries however many pages.
 */
export async function readHeapInternals(db: PGliteInterface, table: Relation, events: TraceEvent[]): Promise<HeapPageContents[]> {
  const { shown, read, rows } = namedInTrace(table, events)
  if (shown.length === 0) return []
  const kept = rows.slice(0, MAX_TRACED_ROWS)
  const headers = await readHeapPageHeaders(db, table, read)
  const items = await readHeapItems(db, table, kept)
  const map = await readVisibilityMap(db, table, shown)
  const headerOf = new Map(headers.map((header) => [header.block, header]))
  const itemsOf = new Map<number, LinePointer[]>()
  for (const item of items) {
    const list = itemsOf.get(item.block) ?? []
    list.push(linePointer(item))
    itemsOf.set(item.block, list)
  }
  const keptCount = new Map<number, number>()
  const namedCount = new Map<number, number>()
  rows.forEach((row, i) => {
    namedCount.set(row.block, (namedCount.get(row.block) ?? 0) + 1)
    if (i < kept.length) keptCount.set(row.block, (keptCount.get(row.block) ?? 0) + 1)
  })

  return shown.map((block) => {
    const header = headerOf.get(block)
    const inMap = Math.floor(block / map.heapPagesPerMapPage) < map.pages
    return {
      relation: table.oid,
      block,
      header: header ? { lower: header.lower, upper: header.upper, linePointers: header.linePointers } : null,
      visibility: inMap ? { allVisible: map.allVisible.has(block), allFrozen: map.allFrozen.has(block) } : null,
      linePointers: itemsOf.get(block) ?? [],
      complete: (keptCount.get(block) ?? 0) === (namedCount.get(block) ?? 0),
    }
  })
}

/**
 * The table's heap pages the events show, in the order first shown; the ones
 * the query read; and the rows on those that the events name, in the order
 * first named.
 */
function namedInTrace(table: Relation, events: TraceEvent[]) {
  const shown: number[] = []
  const read = new Set<number>()
  const seen = new Set<number>()
  const show = (block: number) => {
    if (!seen.has(block)) {
      seen.add(block)
      shown.push(block)
    }
  }
  const named: Tid[] = []
  const rowSeen = new Set<string>()
  const name = (row: Tid) => {
    const key = `${row.block},${row.offset}`
    if (!rowSeen.has(key)) {
      rowSeen.add(key)
      named.push({ block: row.block, offset: row.offset })
    }
  }
  for (const event of events) {
    switch (event.type) {
      case 'buffer.hit':
      case 'buffer.read':
        if (event.page.relation === table.oid && event.page.fork === undefined) {
          show(event.page.block)
          read.add(event.page.block)
        }
        break
      case 'visibility.check':
        if (event.page.relation === table.oid) show(event.page.block)
        name(event.row)
        break
      case 'heap.tuple':
        if (event.row.relation === table.oid) {
          name(event.row)
          if (event.visible) name(event.visible)
        }
        break
      case 'row.emit':
        if (event.row.relation === table.oid) name(event.row)
        break
    }
  }
  // Rows on pages the query didn't read (an index-only scan's all-visible pages) have no line pointers to show.
  const rows = named.filter((row) => read.has(row.block))
  return { shown, read: shown.filter((block) => read.has(block)), rows }
}

/** A line pointer as the trace keeps it, from what heap_page_items read. */
export function linePointer(item: HeapItem): LinePointer {
  return {
    offset: item.offset,
    state: item.state,
    redirectTo: item.redirectTo,
    tupleStart: item.tupleStart,
    length: item.length,
    header:
      item.xmin === null || item.xmax === null || item.ctid === null || item.infomask === null || item.infomask2 === null
        ? null
        : {
            xmin: item.xmin,
            xmax: item.xmax,
            ctid: item.ctid,
            infomask: item.infomask,
            infomask2: item.infomask2,
            flags: item.infomaskFlags,
            combinedFlags: item.combinedFlags,
          },
  }
}
