import type { PGliteInterface } from '@electric-sql/pglite'
import type { Relation, Tid } from '../db/inspector'
import type { PlanNode } from '../db/plan'
import type { IndexStep } from './btreeScan'
import type { SharedBuffers } from './buffers'
import { entryTids, fetchRows, tidText, type FetchedRow, type IndexWalk } from './indexScan'
import type { TraceEvent } from './trace'

/*
 * Replays a Bitmap Heap Scan and the Bitmap Index Scan under it, the way
 * Postgres 18 runs the pair (nodeBitmapHeapscan.c, nodeBitmapIndexscan.c):
 *
 * 1. Before reading any heap page, the Bitmap Heap Scan has its child run to
 *    the end. The Bitmap Index Scan walks its index as an index scan does
 *    (btreeScan.ts), but fetches nothing: it marks each matching entry's row
 *    in a bitmap (btgetbitmap), which holds, for each heap page, the rows on
 *    it that matched. It marks no entries dead: only a scan that fetches rows
 *    finds out nobody can see them.
 * 2. The Bitmap Heap Scan sorts the bitmap's pages into physical order
 *    (tbm_begin_iterate) and reads each page once. On each, it checks the
 *    marked rows in line pointer order: can the query see the row, or a newer
 *    version of it on the same page (heap_hot_search_buffer)? Then it checks
 *    the Filter on the ones it can see, and returns the rows that pass.
 *
 * The Recheck Cond is checked only on a lossy page, one the bitmap kept as a
 * whole page because it outgrew work_mem. The replay doesn't model that:
 * replayQuery reports a lossy bitmap as not supported.
 *
 * Step 1's walk runs before the query does (walkIndexScan), like an index
 * scan's; the rest after (replayBitmapScan).
 */

/**
 * The trace of a Bitmap Heap Scan at the top of the plan (`heapNode`) over
 * a Bitmap Index Scan (`indexNode`), from the index scan's walk, after the
 * query has run: asks Postgres which version of each marked row the query
 * sees, and whether it passes the Filter.
 */
export async function replayBitmapScan(
  db: PGliteInterface,
  heapNode: PlanNode,
  indexNode: PlanNode,
  table: Relation,
  index: Relation,
  walk: IndexWalk,
  buffers: SharedBuffers,
): Promise<TraceEvent[]> {
  const rows = await fetchRows(db, heapNode, table, entryTids(walk))
  return [...bitmapScanEvents(heapNode, indexNode, table, index, walk.steps, rows, buffers)]
}

/**
 * The rows a bitmap marks, by heap page, in physical order: pages by
 * number, and each page's line pointer numbers in order, each once.
 */
export function bitmapPages(tids: Tid[]): { block: number; offsets: number[] }[] {
  const pages = new Map<number, Set<number>>()
  for (const tid of tids) {
    const offsets = pages.get(tid.block) ?? new Set<number>()
    offsets.add(tid.offset)
    pages.set(tid.block, offsets)
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([block, offsets]) => ({ block, offsets: [...offsets].sort((a, b) => a - b) }))
}

/**
 * The trace: the Bitmap Index Scan's pages and matching entries, each
 * entry's row marked in the bitmap; then each heap page the bitmap marks,
 * in order, as one hit or read, and each marked row on it, checked, and
 * sent to the result if it passes.
 */
export function* bitmapScanEvents(
  heapNode: PlanNode,
  indexNode: PlanNode,
  table: Relation,
  index: Relation,
  steps: IndexStep[],
  rows: Map<string, FetchedRow>,
  buffers: SharedBuffers,
): Generator<TraceEvent> {
  yield { type: 'node.start', node: heapNode.id }

  // 1. The Bitmap Index Scan builds the bitmap.
  yield { type: 'node.start', node: indexNode.id }
  const marked: Tid[] = []
  for (const step of steps) {
    if (step.kind === 'search') {
      yield { type: 'index.search', node: indexNode.id, index: index.oid }
    } else if (step.kind === 'visit') {
      const page = { relation: index.oid, block: step.page.block }
      yield { type: buffers.access(page), node: indexNode.id, page }
      yield { type: 'index.visit', node: indexNode.id, page, level: step.page.level, downlink: step.downlink }
    } else {
      marked.push(step.tid)
      const page = { relation: index.oid, block: step.block }
      const row = { relation: table.oid, ...step.tid }
      yield { type: 'index.entry', node: indexNode.id, page, offset: step.offset, key: step.key, row, bitmap: true }
    }
  }
  yield { type: 'node.finish', node: indexNode.id }

  // 2. The Bitmap Heap Scan reads each page the bitmap marks, in order.
  let resultIndex = 0
  for (const { block, offsets } of bitmapPages(marked)) {
    const page = { relation: table.oid, block }
    yield { type: buffers.access(page), node: heapNode.id, page }
    for (const offset of offsets) {
      const row = { relation: table.oid, block, offset }
      const fetched = rows.get(tidText(row)) as FetchedRow
      const visible = fetched.visible === null ? null : { relation: table.oid, ...fetched.visible }
      yield { type: 'heap.tuple', node: heapNode.id, row, visible, matched: fetched.matched }
      if (visible !== null && fetched.matched) {
        yield { type: 'row.emit', node: heapNode.id, row: visible, resultIndex: resultIndex++ }
      }
    }
  }
  yield { type: 'node.finish', node: heapNode.id }
}
