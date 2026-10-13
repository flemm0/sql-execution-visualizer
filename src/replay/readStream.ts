import type { SharedBuffers } from './buffers'
import type { TraceEvent } from './trace'

/*
 * Postgres 18's read stream (read_stream.c), which a Seq Scan and a Bitmap
 * Heap Scan read their heap pages through. It asks for the pages a scan will
 * need next ahead of time, more of them after each I/O, in batches of
 * consecutive pages read in one I/O. A scan that goes to its end uses every
 * page it asked for, and costs one hit or read per page, as the replay
 * draws it. A scan stopped early (by a Limit) has asked for pages it never
 * uses, and Postgres counts some of those too. This works out which.
 *
 * PGlite runs Postgres with io_method = sync, where a page's I/O happens
 * (and counts as a read) when the scan comes to the first page of the batch,
 * and a page already in shared buffers counts as a hit as soon as the stream
 * pins it, ahead of the scan. A port of the parts of read_stream.c that
 * decide this, in sync mode (read_stream_next_buffer, read_stream_look_ahead,
 * read_stream_start_pending_read), and of StartReadBuffersImpl and
 * WaitReadBuffers in bufmgr.c. Left out: the fast path for one page at a
 * time, which costs the same, and advice to the kernel, which costs nothing.
 */

/** The settings that shape a read stream. */
export interface ReadStreamSettings {
  /** io_combine_limit: the most pages one I/O reads. */
  ioCombineLimit: number
  /** effective_io_concurrency: the most I/Os under way at once. */
  maxIos: number
  /**
   * The most buffers one backend should pin (MaxProportionalPins:
   * shared_buffers / (MaxBackends + NUM_AUXILIARY_PROCS)).
   */
  pinLimit: number
  /** Buffers the backend holds pinned besides the stream's: the scan's page, and its last row's. */
  otherPins: number
}

/**
 * PGlite's: shared_buffers 16,384 pages; MaxBackends 128 (100 connections,
 * 16 autovacuum worker slots, 10 WAL senders, 2 special workers) plus 38
 * auxiliary processes; io_combine_limit 16 and effective_io_concurrency 16.
 */
export const PGLITE_READ_STREAM: ReadStreamSettings = {
  ioCombineLimit: 16,
  maxIos: 16,
  pinLimit: Math.floor(16384 / (128 + 38)),
  otherPins: 2,
}

/** Pins in Postgres's per-backend array of buffer references (REFCOUNT_ARRAY_ENTRIES). */
const REFCOUNT_ARRAY_ENTRIES = 8

/** One I/O under way: consecutive pages, by their place in the stream. */
interface Io {
  first: number
  count: number
}

/** A buffer the stream holds pinned, by its page's place in the stream; `io` on the first page of an I/O. */
interface Pinned {
  position: number
  io: Io | null
}

/**
 * The pages, beyond the first `consumed`, that Postgres counts as a hit or a
 * read when a scan reading `blocks` in this order takes only the first
 * `consumed` of them: by their place in `blocks`, in the order counted.
 * `cached(position)` says whether the page at that place in `blocks` was in
 * shared buffers when the scan began.
 */
export function unusedReadAhead(
  blocks: number[],
  cached: (position: number) => boolean,
  consumed: number,
  settings: ReadStreamSettings = PGLITE_READ_STREAM,
): number[] {
  const stream = new ReadStream(blocks, cached, settings)
  for (let i = 0; i < consumed; i++) {
    if (stream.next() === null) break
  }
  return stream.counted.filter((position) => position >= consumed)
}

/**
 * The trace events for the pages a read stream counted that a stopped scan
 * never used (see unusedReadAhead), marked `ahead`. `blocks` are the heap
 * pages the scan would have read, in order, and `cachedAtStart` whether each
 * was in shared buffers when the scan began; it took the first `consumed`.
 */
export function* unusedReadAheadEvents(
  node: number,
  table: number,
  blocks: number[],
  cachedAtStart: boolean[],
  consumed: number,
  buffers: SharedBuffers,
): Generator<TraceEvent> {
  for (const position of unusedReadAhead(blocks, (at) => cachedAtStart[at], consumed)) {
    const page = { relation: table, block: blocks[position] }
    yield { type: buffers.access(page), node, page, ahead: true }
  }
}

class ReadStream {
  /** Every page counted so far, by its place in the stream, in the order counted. */
  counted: number[] = []

  private blocks: number[]
  private cached: (position: number) => boolean
  private settings: ReadStreamSettings
  private maxPinned: number
  /** How many buffers ahead it wants pinned; 0 once the scan has no more pages. */
  private distance = 1
  /** The buffers it holds pinned, oldest first. */
  private pinned: Pinned[] = []
  /** The I/Os under way, oldest first. */
  private ios: Io[] = []
  /** Pages gathered for the next I/O: from `pendingStart`, `pendingCount` of them. */
  private pendingStart = 0
  private pendingCount = 0
  /** Of the pending pages, how many at its start are already pinned (by an earlier, shortened I/O). */
  private forwarded = 0
  /** The next page to ask the scan for. */
  private nextPosition = 0
  /** Pages in shared buffers: cached when the scan began, or read since. */
  private valid = new Set<number>()

  constructor(blocks: number[], cached: (position: number) => boolean, settings: ReadStreamSettings) {
    this.blocks = blocks
    this.cached = cached
    this.settings = settings
    // read_stream_begin_impl: (max_ios + 1) * io_combine_limit, but no more than the backend may pin.
    this.maxPinned = Math.max(1, Math.min((settings.maxIos + 1) * settings.ioCombineLimit, settings.pinLimit))
  }

  /** Gives the scan its next page (read_stream_next_buffer); null at the end. */
  next(): number | null {
    if (this.pinned.length === 0) {
      if (this.distance === 0) return null
      this.lookAhead()
      if (this.pinned.length === 0) return null
    }
    const oldest = this.pinned[0]
    // Its I/O is the oldest under way: wait for it, which in sync mode reads all its pages.
    if (this.ios.length > 0 && oldest.io === this.ios[0]) {
      const io = this.ios.shift() as Io
      for (let position = io.first; position < io.first + io.count; position++) {
        this.counted.push(position)
        this.valid.add(position)
      }
      // Look-ahead distance ramps up rapidly after an I/O.
      this.distance = Math.min(this.distance * 2, this.maxPinned)
    }
    this.pinned.shift()
    this.lookAhead()
    return oldest.position
  }

  /** Gathers the next pages into I/Os, as far ahead as the distance allows (read_stream_look_ahead). */
  private lookAhead() {
    const { maxIos, ioCombineLimit } = this.settings
    while (this.ios.length < maxIos && this.pinned.length + this.pendingCount < this.distance) {
      if (this.pendingCount === ioCombineLimit) {
        this.startPendingRead()
        continue
      }
      const position = this.nextPosition < this.blocks.length ? this.nextPosition++ : null
      if (position === null) {
        // End of the stream.
        this.distance = 0
        break
      }
      // The next page after the pending ones joins their I/O.
      if (this.pendingCount > 0 && this.blocks[this.pendingStart] + this.pendingCount === this.blocks[position]) {
        this.pendingCount++
        continue
      }
      while (this.pendingCount > 0) {
        if (!this.startPendingRead() || this.ios.length === maxIos) {
          // Out of buffers or I/Os: put the page back for next time.
          this.nextPosition--
          return
        }
      }
      this.pendingStart = position
      this.pendingCount = 1
    }
    if (
      this.pendingCount > 0 &&
      (this.pendingCount === ioCombineLimit ||
        (this.pendingCount >= this.distance && this.pinned.length === 0) ||
        this.distance === 0) &&
      this.ios.length < maxIos
    ) {
      this.startPendingRead()
    }
  }

  /**
   * Pins the pending pages and starts their I/O (read_stream_start_pending_read,
   * StartReadBuffers): a page already in shared buffers first is a hit, and
   * on its own; otherwise the I/O stops before the first page that is. In
   * sync mode the I/O itself waits until the scan comes to its first page.
   * False when the backend may pin no more buffers for now.
   */
  private startPendingRead(): boolean {
    const { pinLimit, otherPins } = this.settings
    let nblocks = this.pendingCount
    // GetAdditionalPinLimit: the backend counts at least the pins its fixed array holds.
    const held = Math.max(REFCOUNT_ARRAY_ENTRIES, this.pinned.length + this.forwarded + otherPins)
    let bufferLimit = (held > pinLimit ? 0 : pinLimit - held) + this.forwarded
    if (bufferLimit === 0 && this.pinned.length === 0) bufferLimit = 1
    if (bufferLimit < nblocks) {
      this.distance = Math.min(this.distance, this.pinned.length + bufferLimit)
      if (this.pinned.length > 0) return false
      nblocks = bufferLimit
    }

    let needWait = true
    let actual = nblocks
    let forwardedNext = 0
    for (let i = 0; i < nblocks; i++) {
      const position = this.pendingStart + i
      let found: boolean
      if (i < this.forwarded) {
        found = this.valid.has(position)
      } else {
        found = this.valid.has(position) || this.cached(position)
        // PinBufferForBlock counts a hit when the page is already there.
        if (found) {
          this.counted.push(position)
          this.valid.add(position)
        }
      }
      if (found) {
        if (i === 0) {
          actual = 1
          needWait = false
        } else {
          // The I/O stops before it; it stays pinned, for the next one.
          actual = i
          forwardedNext = 1
        }
        break
      }
    }

    const io = needWait ? { first: this.pendingStart, count: actual } : null
    for (let i = 0; i < actual; i++) this.pinned.push({ position: this.pendingStart + i, io: i === 0 ? io : null })
    if (io === null) {
      // Look-ahead distance decays when no I/O is needed.
      if (this.distance > 1) this.distance--
    } else {
      this.ios.push(io)
    }
    this.forwarded = forwardedNext
    this.pendingStart += actual
    this.pendingCount -= actual
    return true
  }
}
