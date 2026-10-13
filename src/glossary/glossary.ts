/*
 * The glossary: a plain-language definition for every real Postgres term the
 * UI shows (docs/UX.md#defaults, ADR 0040). The wording lives here and only
 * here; <Term> shows it as a tooltip. Definitions are for developers who
 * write SQL but have never looked under the hood: one or two sentences,
 * accurate to Postgres 18, using the same words as the captions ("heap
 * page", "shared buffers", "read from disk into a buffer").
 *
 * Keys are the term as the tooltip names it: Postgres's own spelling for plan
 * nodes and EXPLAIN fields ("Index Cond"), lower case for everything else.
 */
export const GLOSSARY = {
  /* ------------------------------------------------------------ storage */
  heap: 'The table’s own storage: its rows, in no particular order, in a file of numbered 8 kB pages. Indexes are separate files that point into it.',
  page: 'The 8 kB unit Postgres reads, caches and writes; every table and index is a file of numbered pages (Postgres also calls them blocks). Heap pages and index pages are numbered separately.',
  ctid: 'A row version’s address in the heap, as (page, item): (212,4) is item 4 on heap page 212. Index entries find rows by their ctid, and an UPDATE gives the new version a new one.',
  'row version':
    'Postgres never changes a row in place: an UPDATE writes a new version of it and a DELETE marks it deleted, and the old version stays on its page until VACUUM removes it. Postgres calls each version a tuple.',
  tuple: 'Postgres’s word for one row version as stored on a page: a header (with xmin and xmax) followed by the row’s values.',
  'line pointer':
    'A slot in a heap page’s array of row versions; the item number in a ctid is the slot’s number. A slot points at a row version, or is dead (its row removed, though an index may still point here), unused (free), or a redirect to a newer version on the same page.',
  'dead row':
    'A row version no transaction can see any more: it was deleted or replaced by an UPDATE that committed before any transaction still running began. It takes up space until VACUUM removes it.',

  /* --------------------------------------------------------- visibility */
  MVCC: 'Multi-version concurrency control: writers create new row versions instead of overwriting rows, so each query sees a consistent snapshot of the data and readers never wait for writers.',
  visible:
    'Whether a row version exists for this query (MVCC visibility): it was committed when the query started (or made earlier in the query’s own transaction), and wasn’t deleted or replaced by a change committed by then. Versions that aren’t visible are skipped.',
  xmin: 'The ID of the transaction that created a row version. Other transactions see the version only if their query started after that transaction committed.',
  xmax: 'The ID of the transaction that deleted or replaced a row version (0 if none has). Once it commits, queries that start afterwards no longer see the version.',
  'visibility map':
    'A small companion file of each table, with bits for every heap page; one says the page is all-visible. VACUUM sets the bits, and any change to the page clears them.',
  'all-visible':
    'A visibility map bit saying every row version on the heap page is visible to every transaction. An Index Only Scan trusts it and takes the values from the index without reading the page.',

  /* ------------------------------------------------------------ indexes */
  index: 'A separate structure that maps column values to the heap rows holding them, so a query can find matching rows without reading the whole table. Postgres’s default kind is the B-tree.',
  'B-tree':
    'Postgres’s default index: a tree of pages with the keys kept in sorted order. A search starts at the root page, follows downlinks through internal pages, and ends on a leaf, whose entries point at heap rows.',
  root: 'The B-tree’s top page, where every search starts. Its downlinks divide the whole range of keys among the pages below it.',
  'internal page': 'A B-tree page between the root and the leaves. It holds only downlinks, which lead to the pages one level down.',
  leaf: 'A page on the B-tree’s bottom level. Its entries hold the keys in order, each pointing at heap rows by ctid, and each leaf links to its neighbors so a scan can move right.',
  downlink:
    'An entry on a root or internal page: a key and the child page one level down. The child holds the keys from that key up to the next downlink’s; a page’s first downlink has no key (minus infinity).',
  'high key':
    'The first item on every B-tree page except the rightmost of its level: an upper bound on the keys the page holds. A search whose key is above it moves right to the next page.',
  'index entry':
    'An item on a B-tree leaf: a key and the ctid of the heap row it came from, or several ctids when equal keys were merged into one entry (deduplication).',
  'dead entry':
    'An index entry whose heap row no transaction can see any more. An index scan that finds one marks it dead so later scans skip it without visiting the heap; VACUUM removes it for good.',
  'index search':
    'One descent of the B-tree from the root down to a leaf, followed by reading entries to the right. A simple condition needs one; IN lists and skip scans can need several.',
  'skip scan':
    'New in Postgres 18: a multi-column B-tree can be used even when the query doesn’t constrain its leading column, by searching the index again for each distinct value of that column.',

  /* ------------------------------------------------------------ buffers */
  'shared buffers':
    'Postgres’s cache of pages in memory, shared by every session. Every page a query uses is first looked for there, and read from disk into a buffer if it’s missing.',
  'buffer hit': 'The page a query needed was already in shared buffers, so no disk read was needed.',
  'buffer read': 'The page a query needed wasn’t in shared buffers, so Postgres read it from disk into a buffer.',
  bitmap:
    'A Bitmap Index Scan’s list, in memory, of the heap rows that match, grouped by page. The Bitmap Heap Scan above it reads each marked page once, in physical order.',

  /* -------------------------------------------------------- maintenance */
  VACUUM: 'Removes row versions no transaction can see any more, and the index entries pointing at them, so their space can be reused. It also updates the visibility map.',
  ANALYZE:
    'Samples a table’s rows and saves statistics about each column (common values, how values are spread, how many are distinct). The planner uses them to estimate how many rows each step returns.',
  autovacuum:
    'Postgres’s background process that runs VACUUM and ANALYZE on a table once enough of its rows have changed. PGlite has none, so this app simulates it after each run.',

  /* --------------------------------------------------------- plan nodes */
  'Seq Scan': 'Reads the table’s heap from the first page to the last and checks every visible row against the Filter. It needs no index.',
  'Index Scan': 'Searches a B-tree index for the matching entries, then fetches each entry’s row from the heap by its ctid, in index order.',
  'Index Only Scan':
    'Like an Index Scan, but takes the values from the index entries themselves; it reads the heap only for pages the visibility map doesn’t mark all-visible, to check the row is visible.',
  'Bitmap Index Scan':
    'Searches an index and, instead of fetching each matching row, marks it in a bitmap. The Bitmap Heap Scan above it then reads the rows.',
  'Bitmap Heap Scan':
    'Reads the heap pages a bitmap marks, each once and in physical order, and passes on the marked rows that are visible. When many rows match, that is fewer page reads than an Index Scan.',
  Sort: 'Puts its input rows in order by the Sort Key: in memory when they fit in work_mem, otherwise using temporary files on disk.',
  Limit: 'Passes on the first rows its input returns (after skipping any OFFSET), then stops asking for more.',
  'Nested Loop': 'Joins two inputs by running the inner one again for each row of the outer one, keeping the pairs that match.',
  'Hash Join': 'Joins two inputs by building a hash table from the inner one, then looking up each outer row’s join values in it.',
  Hash: 'Builds the in-memory hash table a Hash Join looks rows up in, from its input’s rows.',
  'Merge Join': 'Joins two inputs that are both sorted on the join columns by walking through them side by side.',
  Aggregate: 'Computes aggregate functions such as count() or sum() over all of its input rows, returning one row.',
  GroupAggregate: 'Computes aggregates per group from input already sorted by the Group Key, finishing each group as the next one starts.',
  HashAggregate: 'Computes aggregates per group by keeping one entry per Group Key value in a hash table, so its input needn’t be sorted.',
  Materialize: 'Keeps its input’s rows in memory (or on disk if they don’t fit) so a parent that reads them several times doesn’t recompute them.',

  /* ---------------------------------------------------- EXPLAIN details */
  'estimated rows':
    'The planner’s guess, made before running, of how many rows the node returns, based on the table’s statistics; next to it, the rows it actually returned. A big gap means the plan was chosen on wrong numbers.',
  'Index Cond': 'The conditions the index answers itself: the scan uses them to find where to start and stop in the B-tree, so rows outside them are never visited.',
  Filter: 'A condition checked on each row after it has been read; rows that fail are thrown away. Unlike an Index Cond, a Filter doesn’t reduce the pages read.',
  'Rows Removed by Filter': 'How many rows the Filter rejected. Many removed rows mean the node read many more rows than it returned.',
  'Recheck Cond':
    'The condition a Bitmap Heap Scan checks again on rows it reads. It is applied only when the bitmap lost track of exact rows on a page (lossy) or the index’s matches are approximate.',
  'Rows Removed by Index Recheck': 'Rows that failed the Recheck Cond: they were on a lossy page of the bitmap, or the index’s match was only approximate.',
  'Index Searches':
    'How many times the scan searched the B-tree down from the root (shown from Postgres 18). One for a simple condition; more for IN lists, skip scans, or a scan run again in a loop.',
  'Heap Fetches': 'Rows an Index Only Scan had to look up in the heap because the visibility map didn’t mark their page all-visible. Zero means every value came from the index alone.',
  'Exact Heap Blocks': 'Heap pages a Bitmap Heap Scan read for which the bitmap still knew exactly which rows matched.',
  'Lossy Heap Blocks':
    'Heap pages for which the bitmap, to fit in work_mem, kept only “some rows on this page match”, so every row on them was checked against the Recheck Cond.',
  'Hash Cond': 'The join condition a Hash Join matches rows on, by looking each outer row’s values up in the hash table.',
  'Merge Cond': 'The join condition a Merge Join matches rows on, walking both inputs, sorted on it, side by side.',
  'Join Filter': 'A condition a join checks on each pair of rows it matched; pairs that fail are thrown away.',
  'Rows Removed by Join Filter': 'How many matched pairs of rows the Join Filter threw away.',
  'Sort Key': 'The expressions a Sort orders rows by, most significant first.',
  'Sort Method':
    'How the Sort did it: quicksort in memory, top-N heapsort (keeping only the rows a Limit needs), or external merge using temporary files when the rows didn’t fit in work_mem.',
  'Group Key': 'The expressions an aggregate groups rows by: it returns one row per distinct combination of their values.',
  'Presorted Key': 'The leading sort keys an Incremental Sort’s input is already ordered by, so it only sorts within each group of equal values.',
} satisfies Record<string, string>

/** A term the glossary defines: one of GLOSSARY's keys. */
export type GlossaryTerm = keyof typeof GLOSSARY

/** Whether `name` is a term the glossary defines, e.g. a label read from EXPLAIN. */
export function isGlossaryTerm(name: string): name is GlossaryTerm {
  return Object.hasOwn(GLOSSARY, name)
}

/**
 * The part of a plan node's heading that names its node type, and the term
 * for it: "Index Scan" in "Index Scan using orders_pkey on orders",
 * "HashAggregate" (an Aggregate node) in "HashAggregate". Null when the
 * glossary has no term for it, or the heading doesn't start with it (a join
 * type moves into the name: "Hash Left Join").
 */
export function nodeTypeTerm(title: string, nodeType: string): GlossaryTerm | null {
  const name = nodeType === 'Aggregate' ? title.split(' ')[0] : nodeType
  if (!isGlossaryTerm(name)) return null
  return title === name || title.startsWith(`${name} `) ? name : null
}
