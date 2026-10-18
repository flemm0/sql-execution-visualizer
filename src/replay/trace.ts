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
  /** See BufferReadEvent. */
  ahead?: true
}

/** A node asks for a page that isn't in shared buffers, so it's read from disk into a buffer. */
export interface BufferReadEvent {
  type: 'buffer.read'
  node: number
  page: PageRef
  /**
   * True for a page the scan asked for ahead of time and never got to: a
   * Seq Scan or Bitmap Heap Scan reads (or pins) the pages it will need next
   * in batches (Postgres 18's read stream), and a Limit stopped it before it
   * reached this one. Shown when the scan stops. Absent for a page the scan
   * goes through: its access is drawn when the scan reaches it.
   */
  ahead?: true
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
  /**
   * When a Limit stopped the scan part way through the page, the visible rows
   * it got to: the filter was checked on those only. Absent when it went
   * through all of them.
   */
  checkedRows?: number
  /** Rows that passed the filter (all visible rows when there is none), of those it checked. */
  matchedRows: number
}

/**
 * An index scan starts a search down its index, from the root, for the first
 * entry that can match (for a backward scan, the last). The pages it goes
 * through follow as index.visit events.
 */
export interface IndexSearchEvent {
  type: 'index.search'
  node: number
  /** The index's relation id. */
  index: number
  /**
   * True for a backward scan: it reads entries from high keys to low, and
   * moves to the page on the left for more. Absent for a forward scan.
   */
  backward?: true
}

/**
 * An index scan looks at an index page: on the way down from the root, or
 * moving to the next leaf page for more matches (to the right, or for a
 * backward scan, to the left).
 */
export interface IndexVisitEvent {
  type: 'index.visit'
  node: number
  page: PageRef
  /** 0 for a leaf page, one more for each level above. */
  level: number
  /**
   * On the way down, the item (its offset on the page) whose child page the
   * search goes to next; null on a leaf page, or when the search moves to the
   * page's neighbor instead.
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
  /**
   * For a row a join makes: the rows from its outer side that `row`, from its
   * inner side, is joined with, one per table, in plan order. The whole
   * joined row is these, then `row`. Absent for a row of one table.
   */
  outer?: RowRef[]
  /** Which row of the result it becomes, counting from 0; null when it goes to a parent node. */
  resultIndex: number | null
}

/**
 * A Nested Loop has a row from its outer side, and runs its inner side again
 * for it: one loop. The inner side's events follow, until its node.finish.
 * Where the inner side's conditions name a column of the outer row (an Index
 * Cond like o.customer_id = c.id), the row's value is its parameter for this
 * loop.
 */
export interface JoinLoopEvent {
  type: 'join.loop'
  node: number
  /** Which loop this is, counting from 1. */
  loop: number
  /** The outer row, one row per table, in plan order. */
  outer: RowRef[]
  /** The values the inner side uses from it, as Postgres writes them, e.g. { name: "c.id", value: "4242" } (null for NULL). */
  params: { name: string; value: string | null }[]
}

/**
 * A Nested Loop checks its Join Filter on an outer row and a row its inner
 * side passed up. The pair goes on (a row.emit follows) only if it passes.
 */
export interface JoinFilterEvent {
  type: 'join.filter'
  node: number
  /** The outer row, one row per table, in plan order. */
  outer: RowRef[]
  /** The inner row. */
  row: RowRef
  matched: boolean
}

/**
 * A Sort whose parent needs only its first rows (a Limit's bound) holds more
 * than twice that many, so it switches to a top-N heapsort: it keeps the best
 * rows in a heap, with the worst of them on top to compare new rows with,
 * and drops the others.
 */
export interface SortHeapEvent {
  type: 'sort.heap'
  node: number
  /** The rows it keeps, as many as its parent needs. */
  kept: RowRef[]
  /** The rows it drops. */
  dropped: RowRef[]
}

/** In a top-N heapsort, a row from below sorts before the worst row kept, and takes its place. */
export interface SortKeepEvent {
  type: 'sort.keep'
  node: number
  row: RowRef
  /** The worst row kept until now, dropped. */
  replaced: RowRef
}

/** In a top-N heapsort, a row from below doesn't sort before the worst row kept, so it's dropped. */
export interface SortDiscardEvent {
  type: 'sort.discard'
  node: number
  row: RowRef
}

/**
 * A Sort has every row from below, and sorts the ones it holds, in memory.
 * Then it passes them on in order (row.emit events).
 */
export interface SortDoneEvent {
  type: 'sort.done'
  node: number
  /** How many rows it holds, sorted: all it got, or for a top-N heapsort, the best ones. */
  rows: number
  method: 'quicksort' | 'top-N heapsort'
}

/** A Limit skips a row from below, for its OFFSET. */
export interface LimitSkipEvent {
  type: 'limit.skip'
  node: number
  row: RowRef
}

/**
 * A Limit has passed on all the rows it may (its LIMIT), so it stops asking
 * for more. The nodes below it still working stop where they are.
 */
export interface LimitStopEvent {
  type: 'limit.stop'
  node: number
  /** The nodes below it that hadn't finished, stopped early (none for LIMIT 0, which asks for nothing). */
  stopped: number[]
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
  | JoinLoopEvent
  | JoinFilterEvent
  | SortHeapEvent
  | SortKeepEvent
  | SortDiscardEvent
  | SortDoneEvent
  | LimitSkipEvent
  | LimitStopEvent

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

/** A row a Sort was given, with its sort key as Postgres wrote it. */
export interface SortRow {
  row: RowRef
  /** Its sort key's values, one per key, as Postgres writes them (null for NULL). */
  key: (string | null)[]
  /** Its place in the sorted order, from 1; rows that tie on every key share one. */
  rank: number
}

/** A Sort node's rows, so the visualization can show their keys and order them. */
export interface SortContents {
  node: number
  /** The sort keys as the plan writes them, e.g. ["orders.total DESC"]. */
  keys: string[]
  /** Every row it was given, in the order they came. */
  rows: SortRow[]
}

/** A Limit node's settings, as Postgres planned them. */
export interface LimitContents {
  node: number
  /** Rows it skips first (OFFSET); 0 without one. */
  offset: number
  /** The most rows it passes on (LIMIT); null without one. */
  count: number | null
}


/*
 * Internals: Postgres's own bookkeeping on a heap page, which the
 * visualization shows only when "Show internals" is on (docs/UX.md). Unlike
 * the rest of the trace, these are Postgres's terms: line pointers, tuple
 * headers (xmin, xmax, infomask) and the visibility map.
 */

/**
 * A line pointer: the slot on a heap page that a row's ctid names, and the
 * tuple (row version) it points at, with its header.
 */
export interface LinePointer {
  /** Its number on the page: the second part of the row's ctid. */
  offset: number
  /**
   * normal: points at a tuple. unused: free. dead: its tuple was removed, but
   * an index may still point here. redirect: points at another line pointer,
   * where a chain of row versions on this page continues (a HOT update).
   */
  state: 'unused' | 'normal' | 'redirect' | 'dead'
  /** For a redirect, the line pointer it points at. */
  redirectTo: number | null
  /** Where its tuple starts on the page, in bytes (lp_off); null when it points at none. */
  tupleStart: number | null
  /** Its tuple's length in bytes (lp_len). */
  length: number
  /** Its tuple's header; null when it points at no tuple. */
  header: TupleHeader | null
}

/** A tuple's header, as heap_page_items reads it. */
export interface TupleHeader {
  /** The transaction that created this row version. */
  xmin: number
  /** The transaction that deleted or updated it, or locked it; 0 if none. */
  xmax: number
  /** The row version's own place, or after an UPDATE, its newer version's (t_ctid). */
  ctid: { block: number; offset: number }
  /** Status bits (t_infomask, t_infomask2; the low 11 bits of the second are the number of columns). */
  infomask: number
  infomask2: number
  /** The names of the bits set in them, as Postgres writes them (e.g. HEAP_XMIN_COMMITTED). */
  flags: string[]
  /** Names Postgres gives some combinations of those bits (e.g. HEAP_XMIN_FROZEN). */
  combinedFlags: string[]
}

/** A heap page's two bits in its table's visibility map. */
export interface VisibilityBits {
  /** Every row on the page is visible to every transaction. */
  allVisible: boolean
  /** Every row on the page is frozen: VACUUM needn't look at it again. */
  allFrozen: boolean
}

/**
 * A heap page the trace shows, with its internals as Postgres had them just
 * after the query ran: the query itself can set hint bits in tuple headers
 * (e.g. HEAP_XMIN_COMMITTED) and prune row versions no one can see.
 */
export interface HeapPageContents {
  relation: number
  block: number
  /**
   * Its header: where the free space between the line pointers and the
   * tuples starts and ends (pd_lower, pd_upper), and how many line pointers
   * it has. Null when the query didn't read the page (an index-only scan
   * found it all-visible).
   */
  header: { lower: number; upper: number; linePointers: number } | null
  /** Its bits in the visibility map; null when the map doesn't cover the page (no map yet, or the page is newer). */
  visibility: VisibilityBits | null
  /** The line pointers of the rows the events name on this page, in order. Empty when the page wasn't read. */
  linePointers: LinePointer[]
  /**
   * False when the events name rows on this page whose line pointers weren't
   * kept: a trace keeps them for its first MAX_TRACED_ROWS rows only.
   */
  complete: boolean
}

/** The most rows a trace keeps line pointers and tuple headers for. */
export const MAX_TRACED_ROWS = 2_000

export interface Trace {
  relations: TraceRelation[]
  events: TraceEvent[]
  /** Every index page the events visit, with its items, in the order first visited. */
  indexPages: IndexPageContents[]
  /** The rows of each Sort in the plan. */
  sorts: SortContents[]
  /** Each Limit in the plan. */
  limits: LimitContents[]
  /** Every heap page the heap zone shows, with its internals, in the order first visited. */
  heapPages: HeapPageContents[]
}
