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
  /**
   * 'vm' for a page of a table's visibility map, which records which of its
   * heap pages hold only rows every transaction can see. The map is a file of
   * its own, numbered from 0 too. Absent for the table's or index's own pages.
   */
  fork?: 'vm'
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

/**
 * An index entry on a leaf page matches the scan's conditions. It points at a
 * heap row. A bitmap index scan doesn't fetch that row: it marks it in a
 * bitmap, which its parent reads the heap with once the index scan is done.
 */
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
  /** True for a bitmap index scan: the row is marked in its bitmap. Absent for other index scans. */
  bitmap?: true
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

/**
 * An index-only scan checks the visibility map for the heap page an index
 * entry points into. If the page is all-visible (every row on it is visible
 * to every transaction), the entry's own values are the row's, so the scan
 * doesn't fetch the row from the heap. Otherwise a heap.tuple event follows:
 * the scan fetches the row to check the query can see it.
 */
export interface VisibilityCheckEvent {
  type: 'visibility.check'
  node: number
  /** The heap page the entry points into. */
  page: PageRef
  /** The row on it the entry points at. */
  row: RowRef
  allVisible: boolean
  /**
   * When the page is all-visible, whether the entry's values passed the
   * filter (true when there is none); null when it isn't, since the
   * heap.tuple event that follows says.
   */
  matched: boolean | null
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
  | VisibilityCheckEvent
  | RowEmitEvent

/**
 * Whether an event passes a row on from its node: a row.emit, to its parent
 * or to the result, or a bitmap index scan marking a row in the bitmap it
 * hands to its parent. These are the rows Postgres counts for the node.
 */
export function passesRowOn(event: TraceEvent): boolean {
  return event.type === 'row.emit' || (event.type === 'index.entry' && event.bitmap === true)
}

/**
 * One item of an index page, as the scan found it: on a leaf page, an entry
 * (a key and the rows it points at); on a page above, a downlink (a key and
 * the child page holding keys from it up to the next downlink's key).
 */
export interface IndexItem {
  /** Its offset on the page. */
  offset: number
  /**
   * Its key, one value per key column, as Postgres writes them (null for
   * NULL). A downlink can keep fewer columns than the index has (the ones it
   * drops count as minus infinity), and a page's first downlink keeps none: it
   * stands for minus infinity.
   */
  key: (string | null)[]
  /** For a downlink, its child page's number; null for an entry. */
  child: number | null
  /** For an entry, how many rows it points at (more than one for a posting list); 0 for a downlink. */
  rows: number
  /** Marked dead before the query ran: scans skip it. */
  dead: boolean
}

/** An index page the trace goes through, with its items as the scan found them before the query ran. */
export interface IndexPageContents {
  relation: number
  block: number
  /** 0 for a leaf page, one more for each level above. */
  level: number
  /** Whether it's the index's root page. */
  isRoot: boolean
  /** The next page to the right on the same level; null for the rightmost. */
  next: number | null
  /** The upper bound of the keys on the page (in as many columns as it keeps); null on the rightmost page of a level. */
  highKey: (string | null)[] | null
  /** Its downlinks or entries, in order (the high key apart). */
  items: IndexItem[]
}

export interface Trace {
  relations: TraceRelation[]
  events: TraceEvent[]
  /** Every index page the events visit, with its items, in the order first visited. */
  indexPages: IndexPageContents[]
}
