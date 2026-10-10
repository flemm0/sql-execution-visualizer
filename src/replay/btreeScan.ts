import type { PGliteInterface } from '@electric-sql/pglite'
import { readBtreeMeta, readBtreePages, type BtreeItem, type BtreePage, type IndexColumn, type Relation, type Tid } from '../db/inspector'
import { query } from '../db/query'
import { readKey } from './indexKeys'
import { canStep, KeyComparisons, nextValue, previousValue } from './keyComparisons'

/*
 * Walks a B-tree as a forward index scan does in Postgres 18, and records
 * every page it reads and every entry it returns. A port of the parts of
 * nbtree that decide this (nbtsearch.c, nbtutils.c, nbtpreprocesskeys.c);
 * each function names the one it follows, and keeps its structure, so the two
 * can be read side by side. What's left out changes how fast Postgres runs,
 * not which pages it reads: parallel scans, the "look ahead" within a page,
 * and treating keys as not required on pages after a scan's first (startikey).
 *
 * The scan's conditions become scan keys, one or two per index column. With
 * an = ANY list, or a skip scan, the scan has arrays: an = condition that
 * moves through a list of values, in index order. A skip scan adds one for
 * each index column before the last one with a condition that has no =
 * condition of its own: its values are every value in the index, in turn.
 * Each time the scan's arrays move on, the scan either keeps reading leaf
 * pages to the right, or searches down from the root again (another
 * "primitive" index scan, counted in EXPLAIN's Index Searches).
 *
 * Every comparison is made by Postgres (keyComparisons.ts).
 */

type Strategy = '<' | '<=' | '=' | '>=' | '>'

/** A condition of an Index Cond, as parseIndexCond reads it. */
export interface ScanKey {
  /** The key column's position in the index, from 0. */
  column: number
  operator: Strategy | '= ANY'
  /** The value as the plan deparses it, e.g. "4242" or "'Smith'::text"; for = ANY, the list, e.g. "'{1,2}'::integer[]". */
  value: string
}

/** What the scan did in its index, in order. */
export type IndexStep =
  | { kind: 'search' }
  | { kind: 'visit'; page: BtreePage; downlink: number | null }
  | { kind: 'entry'; block: number; offset: number; key: (string | null)[]; tid: Tid }

/** An inequality a skip array's values have to satisfy (its low_compare or high_compare). */
interface Bound {
  strategy: Strategy
  /** A SQL expression. */
  constant: string
}

/**
 * Where a skip array is. "lowest" and "highest" stand for the lowest and
 * highest values its bounds allow (MINVAL, MAXVAL). `next` marks "the next
 * value after this one in the index", for types that can't count up (NEXT).
 */
type SkipElement =
  | { kind: 'lowest' }
  | { kind: 'highest' }
  | { kind: 'null' }
  | { kind: 'value'; value: string; next: boolean }

/** An = ANY list: its values sorted in index order, without duplicates or NULLs. */
interface ListArray {
  kind: 'list'
  elements: string[]
  current: number
}

/** The array a skip scan adds for an index column without an = condition. */
interface SkipArray {
  kind: 'skip'
  low: Bound | null
  high: Bound | null
  /** Whether NULL is one of its values: true when the column has no conditions. */
  hasNull: boolean
  /** Whether its type can count up (skip support). */
  steps: boolean
  element: SkipElement
}

/** A scan key after preprocessing (so->keyData). */
interface Key {
  column: number
  strategy: Strategy
  /** A plain condition's value; null for an array. */
  constant: string | null
  array: ListArray | SkipArray | null
}

/** A B-tree item with its key values, as SQL expressions (null for NULL). */
interface KeyedItem {
  item: BtreeItem
  /** How many key columns it has: all of them for an entry, maybe fewer for a high key or downlink. */
  columns: number
  values: (string | null)[]
}

interface KeyedPage {
  page: BtreePage
  items: KeyedItem[]
}

/** What an insertion scan key holds for one column: a condition's value, a value from the index, or NULL. */
type SearchValue = { kind: 'constant'; sql: string } | { kind: 'value'; sql: string } | { kind: 'null' }

/** What reading one leaf page tracks (BTReadPageState). */
interface PageState {
  /** The page's high key; null on the rightmost page. */
  finaltup: KeyedItem | null
  firstpage: boolean
  continuescan: boolean
  /** Where to go on reading the page; null to read the next item. */
  skip: number | null
  /** How many times a skip array moved on. */
  nskipadvances: number
  /** The position of the page's last item. */
  maxoff: number
}

/** How a call to checkCompare ended. */
interface CompareResult {
  passes: boolean
  continuescan: boolean
  /** The key that failed, or the number of keys. */
  ikey: number
}

/** _bt_advance_array_keys starts a new primitive scan on a page that saw more skip array moves than this. */
const NSKIPADVANCES_THRESHOLD = 3

/** What a scan did in its index, and whether it was a skip scan. */
export interface BtreeWalk {
  steps: IndexStep[]
  skipScan: boolean
}

/**
 * Walks an index as a forward scan with these conditions does, reading each
 * page it reaches. `keys` are sorted by column, lower bounds first.
 */
export async function walkBtree(
  db: PGliteInterface,
  index: Relation,
  columns: IndexColumn[],
  keys: ScanKey[],
): Promise<BtreeWalk> {
  const keyColumns = columns.filter((column) => column.isKey)
  const preprocessed = await preprocessKeys(db, keyColumns, keys)
  if (preprocessed === null) return { steps: [], skipScan: false }
  const scan = new BtreeScan(db, index, columns, preprocessed)
  await scan.run()
  return { steps: scan.steps, skipScan: preprocessed.some((key) => key.array?.kind === 'skip') }
}

/**
 * The scan keys the scan runs with (_bt_preprocess_keys), or null when no
 * row can match, so the scan doesn't search at all (qual_ok = false).
 */
async function preprocessKeys(db: PGliteInterface, columns: IndexColumn[], keys: ScanKey[]): Promise<Key[] | null> {
  const last = Math.max(-1, ...keys.map((key) => key.column))
  const result: Key[] = []
  for (let column = 0; column <= last; column++) {
    const own = keys.filter((key) => key.column === column)
    const equal = own.find((key) => key.operator === '=' || key.operator === '= ANY')
    if (equal?.operator === '= ANY') {
      const elements = await listElements(db, equal.value, columns[column])
      // An empty list matches nothing; a list of one value is a plain = condition.
      if (elements.length === 0) return null
      result.push(
        elements.length === 1
          ? { column, strategy: '=', constant: elements[0], array: null }
          : { column, strategy: '=', constant: null, array: { kind: 'list', elements, current: 0 } },
      )
    } else if (equal) {
      result.push({ column, strategy: '=', constant: equal.value, array: null })
    } else if (column < last) {
      const array = await skipArray(db, columns[column], own)
      if (array === null) return null
      result.push({ column, strategy: '=', constant: null, array })
    } else {
      for (const key of own) result.push({ column, strategy: key.operator as Strategy, constant: key.value, array: null })
    }
  }
  return result
}

/** An = ANY list's values, sorted as the index sorts them, without NULLs or duplicates. */
async function listElements(db: PGliteInterface, list: string, column: IndexColumn): Promise<string[]> {
  const e = column.collation === null ? 'e' : `e COLLATE ${column.collation}`
  const result = await query<{ element: string }>(
    db,
    `SELECT format('%L::%s', e, pg_typeof(e)) AS element
     FROM (SELECT DISTINCT e FROM unnest(${list}) AS list(e) WHERE e IS NOT NULL) AS elements
     ORDER BY ${e}`,
  )
  return result.rows.map((row) => row.element)
}

/**
 * The skip array for a column with these conditions (none, or inequalities),
 * or null if they can't be met. With skip support, "> c" becomes ">= c + 1"
 * and "< c" becomes "<= c - 1" when c has the column's type
 * (_bt_skiparray_strat_adjust), so a search can start at an exact value.
 */
async function skipArray(db: PGliteInterface, column: IndexColumn, own: ScanKey[]): Promise<SkipArray | null> {
  const bound = (operators: string[]): Bound | null => {
    const key = own.find((each) => operators.includes(each.operator))
    return key ? { strategy: key.operator as Strategy, constant: key.value } : null
  }
  const array: SkipArray = {
    kind: 'skip',
    low: bound(['>', '>=']),
    high: bound(['<', '<=']),
    hasNull: own.length === 0,
    steps: canStep(column.type),
    element: { kind: 'lowest' },
  }
  if (!array.steps) return array
  for (const side of ['low', 'high'] as const) {
    const current = array[side]
    if (current === null || (current.strategy !== '>' && current.strategy !== '<')) continue
    const moved = side === 'low' ? nextValue(column.type, current.constant) : previousValue(column.type, current.constant)
    const result = await query<{ same: boolean; moved: string | null }>(
      db,
      `SELECT pg_typeof(${current.constant}) = '${column.type}'::regtype AS same, (${moved})::text AS moved`,
    )
    const { same, moved: text } = result.rows[0]
    if (!same) continue
    // Past the type's first or last value: nothing can match.
    if (text === null) return null
    array[side] = {
      strategy: side === 'low' ? '>=' : '<=',
      constant: `CAST(${quote(text)} AS ${column.type})`,
    }
  }
  return array
}

function quote(text: string) {
  return `'${text.replaceAll("'", "''")}'`
}

/** One forward scan through a B-tree, with its scan keys' state (BTScanOpaque). */
class BtreeScan {
  steps: IndexStep[] = []
  private keyColumns: IndexColumn[]
  private comparisons: KeyComparisons
  private pages = new Map<number, BtreePage>()
  private arrays: Key[]
  private needPrimScan = false
  private scanBehind = false
  private oppositeDirCheck = false
  private moreRight = true
  private fastRoot: number | null = null

  private db: PGliteInterface
  private index: Relation
  private columns: IndexColumn[]
  private keys: Key[]

  constructor(db: PGliteInterface, index: Relation, columns: IndexColumn[], keys: Key[]) {
    this.db = db
    this.index = index
    this.columns = columns
    this.keys = keys
    this.keyColumns = columns.filter((column) => column.isKey)
    this.arrays = keys.filter((key) => key.array !== null)
    const constants = this.keyColumns.map((_, column) => {
      const own: string[] = []
      for (const key of keys.filter((each) => each.column === column)) {
        if (key.constant !== null) own.push(key.constant)
        if (key.array?.kind === 'skip') {
          if (key.array.low) own.push(key.array.low.constant)
          if (key.array.high) own.push(key.array.high.constant)
        }
      }
      return own
    })
    const lists = this.keyColumns.map((_, column) =>
      keys.flatMap((key) => (key.column === column && key.array?.kind === 'list' ? [key.array.elements] : [])),
    )
    const stepping = this.keyColumns.map((_, column) =>
      keys.some((key) => key.column === column && key.array?.kind === 'skip' && key.array.steps),
    )
    this.comparisons = new KeyComparisons(db, this.keyColumns, constants, lists, stepping)
  }

  /** The whole scan (btgettuple): one primitive scan, then another for as long as one is scheduled. */
  async run() {
    do {
      await this.first()
    } while (this.arrays.length > 0 && this.needPrimScan)
  }

  /** A primitive index scan (_bt_first): search down to a leaf, then read leaves to the right. */
  private async first() {
    if (this.arrays.length > 0 && !this.needPrimScan) this.startArrayKeys()
    this.steps.push({ kind: 'search' })

    const { search, nextKey } = this.searchKey()
    let current = await this.read(await this.root(), search)
    // Down to a leaf (_bt_search), or along the left edge without a search key (_bt_endpoint).
    for (;;) {
      const { page } = current
      // A page that split after its parent was read, or was deleted: move right (_bt_moveright).
      // Every page but the rightmost has a high key first.
      const pastHighKey =
        page.next !== null && search.length > 0 && (await this.compareSearch(current.items[0], search)) >= (nextKey ? 0 : 1)
      if (page.next !== null && (page.isIgnored || pastHighKey)) {
        this.steps.push({ kind: 'visit', page, downlink: null })
        current = await this.read(page.next, search)
        continue
      }
      if (page.isLeaf) break
      const position = search.length === 0 ? firstData(page) : (await this.binsrch(current, search, nextKey)) - 1
      const downlink = current.items[position].item
      this.steps.push({ kind: 'visit', page, downlink: downlink.offset })
      current = await this.read(downlink.childBlock as number, search)
    }
    this.steps.push({ kind: 'visit', page: current.page, downlink: null })
    const offnum = search.length === 0 ? firstData(current.page) : await this.binsrch(current, search, nextKey)

    // _bt_readfirstpage, then _bt_steppage and _bt_readnextpage for as long as there can be more.
    this.moreRight = true
    this.needPrimScan = false
    await this.readPage(current, offnum, true)
    let next = current.page.next
    while (next !== null && this.moreRight) {
      const page = await this.read(next, [])
      this.steps.push({ kind: 'visit', page: page.page, downlink: null })
      if (!page.page.isIgnored) await this.readPage(page, firstData(page.page), false)
      next = page.page.next
    }
  }

  /** Postgres keeps the metapage in memory after planning, so reading it isn't part of the scan. */
  private async root() {
    this.fastRoot ??= (await readBtreeMeta(this.db, this.index)).fastRoot
    return this.fastRoot
  }

  /** Reads a page (once: pages don't change during the walk), and has Postgres compare its keys. */
  private async read(block: number, search: SearchValue[]): Promise<KeyedPage> {
    let page = this.pages.get(block)
    if (page === undefined) {
      page = (await readBtreePages(this.db, this.index, [block]))[0]
      this.pages.set(block, page)
    }
    const items = page.items.map((item) => {
      const columns = item.keyColumns ?? this.keyColumns.length
      return { item, columns, values: readKey(item.keyBytes, item.hasNulls, this.columns, columns) }
    })
    const values = this.keyColumns.map((column, i) => {
      const own = items.flatMap((item) => (i < item.columns ? [cast(item.values[i], column)] : []))
      for (const key of this.arrays) {
        const element = key.array?.kind === 'skip' ? key.array.element : null
        if (key.column === i && element?.kind === 'value') own.push(element.value)
      }
      const searched = search[i]
      if (searched?.kind === 'value') own.push(searched.sql)
      return own
    })
    const keyed = items.map((item) => ({ ...item, values: item.values.map((value, i) => cast(value, this.keyColumns[i])) }))
    await this.comparisons.prepare(values)
    return { page, items: keyed }
  }

  /**
   * The search key for a primitive scan (the startKeys loop of _bt_first):
   * the = conditions on leading columns (an array's current value), then one
   * >= or > condition; a skip array at its lowest value contributes its lower
   * bound, if it has one, and ends the key.
   */
  private searchKey(): { search: SearchValue[]; nextKey: boolean } {
    const search: SearchValue[] = []
    let strategy: Strategy = '='
    for (let column = 0; ; column++) {
      const own = this.keys.filter((key) => key.column === column)
      const key = own.find((each) => each.strategy === '=' || each.strategy === '>=' || each.strategy === '>')
      if (key === undefined) break
      let value: SearchValue | null
      let valueStrategy = key.strategy
      let next = false
      if (key.array?.kind === 'skip') {
        const { element, low } = key.array
        if (element.kind === 'lowest' || element.kind === 'highest') {
          value = low === null ? null : { kind: 'constant', sql: low.constant }
          if (low !== null) valueStrategy = low.strategy
        } else if (element.kind === 'null') {
          value = { kind: 'null' }
        } else {
          value = { kind: 'value', sql: element.value }
          next = element.next
        }
      } else {
        value = { kind: 'constant', sql: this.argument(key) }
      }
      if (value === null) break
      search.push(value)
      strategy = valueStrategy
      if (strategy === '>') break
      if (next) {
        strategy = '>'
        break
      }
      if (!this.keys.some((each) => each.column === column + 1)) break
    }
    return { search, nextKey: strategy === '>' }
  }

  /** A plain condition's value, or a list's current value. */
  private argument(key: Key): string {
    if (key.array?.kind === 'list') return key.array.elements[key.array.current]
    return key.constant as string
  }

  /**
   * How the search key compares with an item (_bt_compare): positive if it
   * sorts after it, negative before, 0 if equal in every column the two share.
   */
  private async compareSearch(item: KeyedItem, search: SearchValue[]): Promise<number> {
    const shared = Math.min(item.columns, search.length)
    for (let column = 0; column < shared; column++) {
      const value = item.values[column]
      const key = search[column]
      let result: number
      // NULLs sort after every value.
      if (key.kind === 'null') result = value === null ? 0 : 1
      else if (value === null) result = -1
      else if (key.kind === 'constant') result = -(await this.comparisons.compareWithConstant(column, value, key.sql))
      else result = -(await this.comparisons.compare(column, value, key.sql))
      if (result !== 0) return result
    }
    // A column the item doesn't have stands for "minus infinity": the search key is after it.
    if (search.length > item.columns) return 1
    // Equal to a high key or downlink without a heap row: every entry to its
    // left is lower, so the search can go right (a forward scan wants no row "minus infinity").
    if (item.item.role !== 'entry' && search.length === item.columns && !item.item.hasHeapTid) return 1
    return 0
  }

  /**
   * The position of the first item the search can't skip (_bt_binsrch): the
   * first the search key doesn't sort after (or, for >, sorts before). On an
   * internal page, the search follows the downlink just before it; the first
   * downlink stands for "minus infinity", which every key sorts after.
   */
  private async binsrch(page: KeyedPage, search: SearchValue[], nextKey: boolean): Promise<number> {
    const first = firstData(page.page)
    const threshold = nextKey ? 0 : 1
    for (let i = first; i < page.items.length; i++) {
      const result = i === first && !page.page.isLeaf ? 1 : await this.compareSearch(page.items[i], search)
      if (result < threshold) return i
    }
    return page.items.length
  }

  /**
   * Reads a leaf page's entries from `offnum` on (_bt_readpage), records the
   * ones that match, and decides whether the scan goes on to the next page
   * (moreRight).
   */
  private async readPage(page: KeyedPage, offnum: number, firstpage: boolean) {
    const rightmost = page.page.next === null
    const pstate: PageState = {
      finaltup: null,
      firstpage,
      continuescan: true,
      skip: null,
      nskipadvances: 0,
      maxoff: page.items.length - 1,
    }
    const arrayKeys = this.arrays.length > 0
    if (arrayKeys) {
      if (!rightmost) {
        pstate.finaltup = page.items[0]
        if (this.scanBehind && !(await this.scanBehindCheckKeys(pstate.finaltup))) {
          // Schedule another primitive index scan after all.
          this.moreRight = false
          this.needPrimScan = true
          return
        }
      }
      this.scanBehind = this.oppositeDirCheck = false
    }

    let i = Math.max(offnum, firstData(page.page))
    while (i <= pstate.maxoff) {
      const item = page.items[i]
      // Entries marked dead are skipped without a look.
      if (item.item.dead) {
        i++
        continue
      }
      const passes = await this.checkKeys(pstate, item)
      if (arrayKeys && pstate.skip !== null) {
        i = pstate.skip
        pstate.skip = null
        continue
      }
      if (passes) {
        const key = item.values.map((value, column) => this.comparisons.text(column, value))
        for (const tid of item.item.heapTids) {
          this.steps.push({ kind: 'entry', block: page.page.block, offset: item.item.offset, key, tid })
        }
      }
      if (!pstate.continuescan) break
      i++
    }

    // The high key can tell that the next page has no matches.
    if (pstate.continuescan && !this.scanBehind && !rightmost) await this.checkKeys(pstate, page.items[0])
    if (!pstate.continuescan) this.moreRight = false
  }

  /** Whether an item matches the scan keys; also decides whether the scan goes on (_bt_checkkeys). */
  private async checkKeys(pstate: PageState, item: KeyedItem): Promise<boolean> {
    const result = await this.checkCompare(item, 'forward', 0)
    pstate.continuescan = result.continuescan
    if (this.arrays.length === 0 || result.continuescan) return result.passes

    // Before the start of matches for the arrays' current values: keep going.
    if (await this.tupleBeforeArrayKeys(item, true, result.ikey, null)) {
      pstate.continuescan = true
      return false
    }
    return this.advanceArrayKeys(pstate, item, result.ikey)
  }

  /**
   * Checks an item against the scan keys from `ikey` on (_bt_check_compare).
   * A key that fails and is required in the scan's direction (an upper bound,
   * or =, scanning forward) means no later item matches either.
   */
  private async checkCompare(item: KeyedItem, direction: 'forward' | 'backward', from: number): Promise<CompareResult> {
    for (let ikey = from; ikey < this.keys.length; ikey++) {
      const key = this.keys[ikey]
      const requiredSameDir =
        key.strategy === '=' || (direction === 'forward' ? key.strategy.startsWith('<') : key.strategy.startsWith('>'))
      // A high key may not have every column: the next page's entries can have any value there.
      if (key.column >= item.columns) continue
      const element = key.array?.kind === 'skip' ? key.array.element : null
      if (element !== null && (element.kind === 'lowest' || element.kind === 'highest' || (element.kind === 'value' && element.next))) {
        return { passes: false, continuescan: false, ikey }
      }
      const value = item.values[key.column]
      if (element?.kind === 'null') {
        if (value === null) continue
        return { passes: false, continuescan: !requiredSameDir, ikey }
      }
      // NULLs sort last: scanning forward, after the first one nothing matches.
      if (value === null) return { passes: false, continuescan: direction !== 'forward', ikey }
      if (!satisfies(await this.compareWithKey(key, value), key.strategy)) {
        return { passes: false, continuescan: !requiredSameDir, ikey }
      }
    }
    return { passes: true, continuescan: true, ikey: this.keys.length }
  }

  /** How a value compares with a key's current value (not a sentinel, not NULL). */
  private async compareWithKey(key: Key, value: string): Promise<number> {
    const array = key.array
    if (array?.kind === 'skip' && array.element.kind === 'value') {
      return this.comparisons.compare(key.column, value, array.element.value)
    }
    if (array?.kind === 'list') {
      return this.comparisons.compareWithElement(key.column, value, array.elements, array.current)
    }
    return this.comparisons.compareWithConstant(key.column, value, key.constant as string)
  }

  /** How a value (maybe NULL) compares with an = key's current value (maybe NULL) (_bt_compare_array_skey). */
  private async compareArrayKey(key: Key, value: string | null): Promise<number> {
    const keyNull = key.array?.kind === 'skip' && key.array.element.kind === 'null'
    if (value === null) return keyNull ? 0 : 1
    if (keyNull) return -1
    return this.compareWithKey(key, value)
  }

  /**
   * Whether an item comes before the start of matches for the arrays'
   * current values, so it's too early to move them on
   * (_bt_tuple_before_array_skeys). With `scanBehind`, also reports whether a
   * high key's missing columns might have hidden that.
   */
  private async tupleBeforeArrayKeys(
    item: KeyedItem,
    readpagetup: boolean,
    sktrig: number,
    scanBehind: { value: boolean } | null,
  ): Promise<boolean> {
    if (scanBehind) scanBehind.value = false
    for (let ikey = sktrig; ikey < this.keys.length; ikey++) {
      const key = this.keys[ikey]
      if (key.column >= item.columns) {
        if (scanBehind) scanBehind.value = true
        return false
      }
      if (key.strategy !== '=') {
        if (readpagetup) return false
        continue
      }
      const value = item.values[key.column]
      let result: number
      const array = key.array
      if (array?.kind === 'skip' && (array.element.kind === 'lowest' || array.element.kind === 'highest')) {
        result = await this.binsrchSkipArray(false, value, array)
        if (result === 0) return false
      } else {
        result = await this.compareArrayKey(key, value)
        if (result === 0 && array?.kind === 'skip' && array.element.kind === 'value' && array.element.next) result = -1
      }
      if (result < 0) return true
      if (readpagetup || result !== 0) return false
    }
    return false
  }

  /**
   * Moves the arrays on to the values of an item at or past their current
   * ones (_bt_advance_array_keys), as far as that item allows, and decides
   * whether the scan reads on, searches again from the root (needPrimScan),
   * or has no more matches. Returns whether the item matches the new values.
   */
  private async advanceArrayKeys(pstate: PageState, item: KeyedItem, sktrig: number): Promise<boolean> {
    let beyondEndAdvance = false
    let skipArrayAdvanced = false
    let hasRequiredOppositeDirectionOnly = false
    let allRequiredSatisfied = true

    for (let ikey = 0; ikey < this.keys.length; ikey++) {
      const key = this.keys[ikey]
      const array = key.array
      if (key.strategy !== '=') hasRequiredOppositeDirectionOnly ||= key.strategy.startsWith('>')
      if (ikey < sktrig) continue
      if (key.column >= item.columns) this.scanBehind = true

      if (ikey === sktrig && array === null) {
        beyondEndAdvance = true
        allRequiredSatisfied = false
        continue
      }
      if (key.strategy !== '=') continue
      if (beyondEndAdvance) {
        if (array) this.setLowOrHigh(array, false)
        continue
      }
      if (!allRequiredSatisfied || key.column >= item.columns) {
        if (array) this.setLowOrHigh(array, true)
        continue
      }

      const value = item.values[key.column]
      let result: number
      let setElement = 0
      if (array?.kind === 'skip') {
        result = await this.binsrchSkipArray(ikey === sktrig, value, array)
      } else if (array?.kind === 'list') {
        const found = await this.binsrchList(key, array, ikey === sktrig, value)
        setElement = found.setElement
        result = found.result
      } else {
        result = await this.compareArrayKey(key, value)
      }
      if (result > 0) beyondEndAdvance = true
      if (result !== 0) allRequiredSatisfied = false

      if (array?.kind === 'skip') {
        this.setSkipElement(array, result, value)
        skipArrayAdvanced = true
      } else if (array?.kind === 'list') {
        array.current = setElement
      }
    }

    if (beyondEndAdvance) {
      const advanced = await this.advanceArrayKeysIncrement()
      if (advanced === null) {
        // Every array is past its last value: the whole scan is done.
        pstate.continuescan = false
        this.needPrimScan = false
        return false
      }
      skipArrayAdvanced ||= advanced
    }
    if (skipArrayAdvanced) pstate.nskipadvances++

    if (allRequiredSatisfied) {
      const recheck = await this.checkCompare(item, 'forward', sktrig + 1)
      if (recheck.passes && !this.scanBehind) {
        pstate.continuescan = true
        return true
      }
      if (!recheck.continuescan) {
        // An inequality fails: move the arrays on a second time, past it.
        await this.advanceArrayKeys(pstate, item, recheck.ikey)
        return false
      }
    }

    let newPrimScan = false
    if (!allRequiredSatisfied && pstate.finaltup === item) newPrimScan = true
    else if (!allRequiredSatisfied && pstate.finaltup !== null) {
      const behind = { value: false }
      newPrimScan = await this.tupleBeforeArrayKeys(pstate.finaltup, false, 0, behind)
      this.scanBehind = behind.value
    }
    if (!newPrimScan && !this.scanBehind && hasRequiredOppositeDirectionOnly && pstate.finaltup !== null) {
      newPrimScan = !(await this.oppositeDirCheckKeys(pstate.finaltup))
    }

    if (newPrimScan) {
      // A new search could skip ahead. But keep reading this primitive scan,
      // and check again on the next page, when it has already read a page
      // before this one, or this page moved a skip array on many times.
      if (pstate.firstpage && pstate.nskipadvances <= NSKIPADVANCES_THRESHOLD) {
        pstate.continuescan = false
        this.needPrimScan = true
        return false
      }
      this.scanBehind = true
    }

    pstate.continuescan = true
    this.needPrimScan = false
    if (this.scanBehind) {
      this.oppositeDirCheck = hasRequiredOppositeDirectionOnly
      // Done with this page; the next one's high key decides (scanBehindCheckKeys).
      pstate.skip = pstate.maxoff + 1
    }
    return false
  }

  /**
   * Where a value falls in a list (_bt_binsrch_array_skey): the first value
   * at or after it, searching after the current one when the list's own key
   * triggered the move; `result` is how the value compares with it (1: past
   * the last).
   */
  private async binsrchList(key: Key, array: ListArray, curElemTrig: boolean, value: string | null) {
    const low = curElemTrig ? array.current + 1 : 0
    const high = array.elements.length - 1
    if (low > high) return { setElement: high, result: 1 }
    for (let position = low; position <= high; position++) {
      const result =
        value === null ? 1 : await this.comparisons.compareWithElement(key.column, value, array.elements, position)
      if (result <= 0) return { setElement: position, result }
    }
    return { setElement: high, result: 1 }
  }

  /** Whether a value is in a skip array's range (_bt_binsrch_skiparray_skey): -1 below it, 1 above, 0 in it. */
  private async binsrchSkipArray(curElemTrig: boolean, value: string | null, array: SkipArray): Promise<number> {
    if (array.hasNull) return 0
    if (value === null) return 1
    const column = this.keys.find((key) => key.array === array)?.column as number
    const passes = async (bound: Bound) =>
      satisfies(await this.comparisons.compareWithConstant(column, value, bound.constant), bound.strategy)
    if (!curElemTrig && array.low && !(await passes(array.low))) return -1
    if (array.high && !(await passes(array.high))) return 1
    return 0
  }

  /** Sets a skip array to a value, or to an end of its range (_bt_skiparray_set_element). */
  private setSkipElement(array: SkipArray, result: number, value: string | null) {
    if (result !== 0) this.setLowOrHigh(array, result < 0)
    else if (value === null) array.element = { kind: 'null' }
    else array.element = { kind: 'value', value, next: false }
  }

  /** Sets an array to its first value, or its last (_bt_array_set_low_or_high). NULLs sort last. */
  private setLowOrHigh(array: ListArray | SkipArray, low: boolean) {
    if (array.kind === 'list') array.current = low ? 0 : array.elements.length - 1
    else if (array.hasNull && !low) array.element = { kind: 'null' }
    else array.element = { kind: low ? 'lowest' : 'highest' }
  }

  /** Every array at its first value (_bt_start_array_keys). */
  private startArrayKeys(low = true) {
    for (const key of this.arrays) this.setLowOrHigh(key.array as ListArray | SkipArray, low)
    this.scanBehind = this.oppositeDirCheck = false
  }

  /**
   * Moves the arrays on by one, the last one first, carrying into the one
   * before when it runs out (_bt_advance_array_keys_increment). Returns null
   * when they're all used up, otherwise whether a skip array was involved.
   */
  private async advanceArrayKeysIncrement(): Promise<boolean | null> {
    let skipArraySet = false
    for (const key of [...this.arrays].reverse()) {
      const array = key.array as ListArray | SkipArray
      if (array.kind === 'skip') skipArraySet = true
      if (await this.increment(key, array)) return skipArraySet
      this.setLowOrHigh(array, true)
    }
    // Leave them at their last values, as they were.
    this.startArrayKeys(false)
    return null
  }

  /** Moves one array to its next value; false at its last (_bt_array_increment). */
  private async increment(key: Key, array: ListArray | SkipArray): Promise<boolean> {
    if (array.kind === 'list') {
      if (array.current >= array.elements.length - 1) return false
      array.current++
      return true
    }
    const element = array.element
    if (element.kind !== 'value') return false
    if (!array.steps) {
      // The next value is whatever comes next in the index: a new search finds it.
      array.element = { kind: 'value', value: element.value, next: true }
      return true
    }
    const next = await this.comparisons.next(key.column, element.value)
    if (next === null) {
      if (!array.hasNull) return false
      array.element = { kind: 'null' }
      return true
    }
    if (array.high && !satisfies(await this.comparisons.compareWithConstant(key.column, next, array.high.constant), array.high.strategy)) {
      return false
    }
    array.element = { kind: 'value', value: next, next: false }
    return true
  }

  /**
   * On the page after one that ended with scanBehind set: whether the scan
   * should read it after all, judging by its high key (_bt_scanbehind_checkkeys).
   */
  private async scanBehindCheckKeys(finaltup: KeyedItem): Promise<boolean> {
    const behind = { value: false }
    if (await this.tupleBeforeArrayKeys(finaltup, false, 0, behind)) return false
    if (behind.value) return false
    if (!this.oppositeDirCheck) return true
    return this.oppositeDirCheckKeys(finaltup)
  }

  /** False when the high key fails a lower bound (_bt_oppodir_checkkeys): a new search would skip ahead. */
  private async oppositeDirCheckKeys(finaltup: KeyedItem): Promise<boolean> {
    const result = await this.checkCompare(finaltup, 'backward', 0)
    return result.continuescan || this.keys[result.ikey].strategy === '='
  }
}

/** A decoded value cast to its column's type: the form KeyComparisons knows values by. */
function cast(value: string | null, column: IndexColumn): string | null {
  return value === null ? null : `CAST(${value} AS ${column.type})`
}

/** The position of a page's first downlink or entry: after the high key, which every page but the rightmost has. */
function firstData(page: BtreePage) {
  return page.next === null ? 0 : 1
}

/** Whether a value that compares as `sign` with a key's value passes the key. */
function satisfies(sign: number, strategy: Strategy) {
  switch (strategy) {
    case '<':
      return sign < 0
    case '<=':
      return sign <= 0
    case '=':
      return sign === 0
    case '>=':
      return sign >= 0
    case '>':
      return sign > 0
  }
}
