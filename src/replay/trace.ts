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

/**
 * An index scan starts a search down its index, from the root, for the first
 * entry that can match. The pages it goes through follow as index.visit events.
 */
export interface IndexSearchEvent {
  type: 'index.search'
  node: number
  /** The index's relation id. */
  index: number
}

/**
 * An index scan looks at an index page: on the way down from the root, or
 * moving right to the next leaf page for more matches.
 */
export interface IndexVisitEvent {
  type: 'index.visit'
  node: number
  page: PageRef
  /** 0 for a leaf page, one more for each level above. */
  level: number
  /**
   * On the way down, the item (its offset on the page) whose child page the
   * search goes to next; null on a leaf page, or when the search moves right
   * to the page's neighbor instead.
   */
  downlink: number | null
}

/** An index entry on a leaf page matches the scan's conditions. It points at a heap row. */
export interface IndexEntryEvent {
  type: 'index.entry'
  node: number
  page: PageRef
  /** The entry's offset on the page. */
  offset: number
  /** Its key, one value per key column, as Postgres writes them (null for NULL). */
  key: (string | null)[]
  /** The heap row it points at. */
  row: RowRef
}

/**
 * An index scan marks entries on a leaf page dead: it found that no
 * transaction can see their rows any more, so later scans skip them.
 */
export interface IndexMarkDeadEvent {
  type: 'index.markDead'
  node: number
  page: PageRef
  /** The entries' offsets on the page. */
  offsets: number[]
}

/**
 * An index scan fetches the heap row an index entry points at, and checks
 * it: can the query see that row, or a newer version of it on the same page
 * (an UPDATE that kept the row on its page and left the index alone, a "HOT"
 * update)? If so, does it pass the filter?
 */
export interface HeapTupleEvent {
  type: 'heap.tuple'
  node: number
  /** The row the index entry points at. */
  row: RowRef
  /** The version of it the query can see; null if it can't see any (deleted, or not yet committed). */
  visible: RowRef | null
  /** Whether the visible version passed the filter (true when there is none); false when nothing is visible. */
  matched: boolean
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
  | IndexSearchEvent
  | IndexVisitEvent
  | IndexEntryEvent
  | IndexMarkDeadEvent
  | HeapTupleEvent
  | RowEmitEvent

export interface Trace {
  relations: TraceRelation[]
  events: TraceEvent[]
}
