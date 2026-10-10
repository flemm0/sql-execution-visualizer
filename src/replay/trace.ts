/*
 * The trace: what the executor did to run a query, step by step, as the
 * replay engine reconstructs it. The player and the visualization read only
 * this, so it uses general database words (pages, buffers, rows), nothing
 * specific to Postgres, and refers to plan nodes and relations by number.
 *
 * The visualization writes each step's caption from the event's type and
 * fields.
 */

/** A table or index the trace refers to. */
export interface TraceRelation {
  /** How events refer to it (Postgres's oid for it). */
  id: number
  name: string
  kind: 'table' | 'index'
  /** Its size in pages when the query ran. */
  pages: number
}

/** A page of a table or index. Tables and indexes number their pages separately, from 0. */
export interface PageRef {
  relation: number
  block: number
}

/** A row version's place in a table: its page and line pointer number (Postgres's ctid). */
export interface RowRef {
  relation: number
  block: number
  offset: number
}

/** A plan node begins its work. `node` is the plan node's id (PlanNode.id). */
export interface NodeStartEvent {
  type: 'node.start'
  node: number
}

/** A plan node has no more rows to give. */
export interface NodeFinishEvent {
  type: 'node.finish'
  node: number
}

/** A node asks for a page that is already in shared buffers. */
export interface BufferHitEvent {
  type: 'buffer.hit'
  node: number
  page: PageRef
}

/** A node asks for a page that isn't in shared buffers, so it's read from disk into a buffer. */
export interface BufferReadEvent {
  type: 'buffer.read'
  node: number
  page: PageRef
}

/**
 * A scan goes through every row on a heap page: the rows visible to the
 * query are checked against the filter, and the ones that pass are emitted
 * next (row.emit events). Row versions the query can't see (deleted, or not
 * yet committed) aren't counted.
 */
export interface HeapPageEvent {
  type: 'heap.page'
  node: number
  page: PageRef
  visibleRows: number
  /** Rows that passed the filter (all visible rows when there is none). */
  matchedRows: number
}

/** A node passes a row on: to its parent node, or, from the top node, to the result. */
export interface RowEmitEvent {
  type: 'row.emit'
  node: number
  row: RowRef
  /** Which row of the result it becomes, counting from 0; null when it goes to a parent node. */
  resultIndex: number | null
}

export type TraceEvent =
  | NodeStartEvent
  | NodeFinishEvent
  | BufferHitEvent
  | BufferReadEvent
  | HeapPageEvent
  | RowEmitEvent

export interface Trace {
  relations: TraceRelation[]
  events: TraceEvent[]
}
