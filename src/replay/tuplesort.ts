/*
 * Sorts rows in the order Postgres 18's Sort node does, rows that tie
 * included: a port of the parts of tuplesort.c that run in memory, and of
 * the quicksort they use (sort_template.h). Each function names the one it
 * follows, and keeps its structure, so the two can be read side by side.
 *
 * The comparisons themselves come from Postgres (sort.ts asks it to rank the
 * rows); these functions only decide which rows to compare, and so the order
 * that rows with equal sort keys come out in. Only the sign of a comparison
 * matters, as in Postgres.
 *
 * What's left out: sorts that outgrow work_mem and spill to disk (external
 * merge), and a top-N heapsort that starts early because memory ran out.
 * sort.ts reports both as not available yet.
 */

/** Compares two rows: negative if `a` sorts first, positive if `b` does, 0 if they tie. */
export type Compare<T> = (a: T, b: T) => number

/** What happened to a row given to a sort (tuplesort_puttuple_common). */
export type PutResult<T> =
  /** Kept in memory with the others, to sort at the end. */
  | { kind: 'stored' }
  /**
   * The sort holds more than twice the rows it needs, so it switched to a
   * top-N heapsort: it keeps the best `kept` and drops the rest.
   */
  | { kind: 'switched'; kept: T[]; dropped: T[] }
  /** Better than the worst row kept, which it pushes out. */
  | { kind: 'kept'; replaced: T }
  /** No better than the worst row kept: dropped. */
  | { kind: 'discarded' }

/**
 * A sort in memory (Tuplesortstate). With a bound (the Limit above it needs
 * only the first `bound` rows), it switches to a top-N heapsort once it
 * holds more than twice that many.
 */
export class Tuplesort<T> {
  /** The rows held: in arrival order, or once bounded, a heap with the worst row first. */
  private memtuples: T[] = []
  private bounded = false
  private compare: Compare<T>
  private bound: number | null

  constructor(compare: Compare<T>, bound: number | null) {
    this.compare = compare
    this.bound = bound
  }

  /** Whether it switched to a top-N heapsort. */
  get usedBound(): boolean {
    return this.bounded
  }

  /** Gives the sort a row (tuplesort_puttuple_common). */
  put(row: T): PutResult<T> {
    if (!this.bounded) {
      this.memtuples.push(row)
      if (this.bound !== null && this.memtuples.length > this.bound * 2) return this.makeBoundedHeap(this.bound)
      return { kind: 'stored' }
    }
    // The heap's first row is the worst kept: compared the other way round, the "largest".
    if (this.reversed(row, this.memtuples[0]) <= 0) return { kind: 'discarded' }
    const replaced = this.memtuples[0]
    this.heapReplaceTop(row, this.memtuples.length)
    return { kind: 'kept', replaced }
  }

  /** Every row given, in sorted order (tuplesort_performsort); for a top-N heapsort, the best `bound`. */
  sorted(): T[] {
    if (this.bounded) return this.sortBoundedHeap()
    const rows = [...this.memtuples]
    if (rows.length > 1) quicksort(rows, this.compare)
    return rows
  }

  /** The comparison with the sort direction reversed (reversedirection): a heap of the worst rows on top. */
  private reversed(a: T, b: T): number {
    return -this.compare(a, b)
  }

  /**
   * Switches to a top-N heapsort (make_bounded_heap): goes through the rows
   * held, in the order they came, keeping the best `bound` in a heap whose
   * first row is the worst of them.
   */
  private makeBoundedHeap(bound: number): PutResult<T> {
    const rows = this.memtuples
    this.memtuples = []
    const dropped: T[] = []
    for (const row of rows) {
      if (this.memtuples.length < bound) {
        this.heapInsert(row)
      } else if (this.reversed(row, this.memtuples[0]) <= 0) {
        dropped.push(row)
      } else {
        dropped.push(this.memtuples[0])
        this.heapReplaceTop(row, this.memtuples.length)
      }
    }
    this.bounded = true
    return { kind: 'switched', kept: [...this.memtuples], dropped }
  }

  /** The heap's rows in sorted order (sort_bounded_heap): takes the worst off the top, again and again. */
  private sortBoundedHeap(): T[] {
    const heap = this.memtuples
    let count = heap.length
    while (count > 1) {
      const top = heap[0]
      // tuplesort_heap_delete_top: the last row goes in at the top and sifts down.
      count--
      this.heapReplaceTop(heap[count], count)
      heap[count] = top
    }
    return [...heap]
  }

  /** Adds a row to the heap (tuplesort_heap_insert): it rises past the rows better than it. */
  private heapInsert(row: T) {
    const heap = this.memtuples
    let j = heap.length
    heap.push(row)
    while (j > 0) {
      const i = (j - 1) >> 1
      if (this.reversed(row, heap[i]) >= 0) break
      heap[j] = heap[i]
      j = i
    }
    heap[j] = row
  }

  /**
   * Puts a row in place of the heap's first, among its first `n` rows
   * (tuplesort_heap_replace_top): it sinks below the rows worse than it.
   */
  private heapReplaceTop(row: T, n: number) {
    const heap = this.memtuples
    let i = 0
    for (;;) {
      let j = 2 * i + 1
      if (j >= n) break
      if (j + 1 < n && this.reversed(heap[j], heap[j + 1]) > 0) j++
      if (this.reversed(row, heap[j]) <= 0) break
      heap[i] = heap[j]
      i = j
    }
    heap[i] = row
  }
}

/**
 * Sorts `rows` in place the way Postgres's quicksort does (ST_SORT in
 * sort_template.h, a Bentley & McIlroy quicksort): insertion sort for fewer
 * than 7 rows, a check for rows already in order, the median of three (or of
 * nine) as the pivot, and rows equal to the pivot gathered at both ends,
 * then swapped into the middle. Sorts `n` rows from `start`.
 */
export function quicksort<T>(rows: T[], compare: Compare<T>, start = 0, n = rows.length): void {
  const swap = (i: number, j: number) => {
    const row = rows[i]
    rows[i] = rows[j]
    rows[j] = row
  }
  const swapn = (i: number, j: number, count: number) => {
    for (let k = 0; k < count; k++) swap(i + k, j + k)
  }
  const cmp = (i: number, j: number) => compare(rows[i], rows[j])
  const med3 = (a: number, b: number, c: number) =>
    cmp(a, b) < 0 ? (cmp(b, c) < 0 ? b : cmp(a, c) < 0 ? c : a) : cmp(b, c) > 0 ? b : cmp(a, c) < 0 ? a : c

  let a = start
  // The C version loops with a goto to sort one side, after calling itself for the other.
  for (;;) {
    if (n < 7) {
      for (let pm = a + 1; pm < a + n; pm++) {
        for (let pl = pm; pl > a && cmp(pl - 1, pl) > 0; pl--) swap(pl, pl - 1)
      }
      return
    }
    let presorted = true
    for (let pm = a + 1; pm < a + n; pm++) {
      if (cmp(pm - 1, pm) > 0) {
        presorted = false
        break
      }
    }
    if (presorted) return
    let pm = a + Math.floor(n / 2)
    if (n > 7) {
      let pl = a
      let pn = a + n - 1
      if (n > 40) {
        const d = Math.floor(n / 8)
        pl = med3(pl, pl + d, pl + 2 * d)
        pm = med3(pm - d, pm, pm + d)
        pn = med3(pn - 2 * d, pn - d, pn)
      }
      pm = med3(pl, pm, pn)
    }
    swap(a, pm)
    let pa = a + 1
    let pb = a + 1
    let pc = a + n - 1
    let pd = a + n - 1
    for (;;) {
      let r: number
      while (pb <= pc && (r = cmp(pb, a)) <= 0) {
        if (r === 0) {
          swap(pa, pb)
          pa++
        }
        pb++
      }
      while (pb <= pc && (r = cmp(pc, a)) >= 0) {
        if (r === 0) {
          swap(pc, pd)
          pd--
        }
        pc--
      }
      if (pb > pc) break
      swap(pb, pc)
      pb++
      pc--
    }
    const pn = a + n
    let d1 = Math.min(pa - a, pb - pa)
    swapn(a, pb - d1, d1)
    d1 = Math.min(pd - pc, pn - pd - 1)
    swapn(pb, pn - d1, d1)
    d1 = pb - pa
    const d2 = pd - pc
    if (d1 <= d2) {
      // Sort the left part, then go round again for the right.
      if (d1 > 1) quicksort(rows, compare, a, d1)
      if (d2 <= 1) return
      a = pn - d2
      n = d2
    } else {
      // Sort the right part, then go round again for the left.
      if (d2 > 1) quicksort(rows, compare, pn - d2, d2)
      if (d1 <= 1) return
      n = d1
    }
  }
}
