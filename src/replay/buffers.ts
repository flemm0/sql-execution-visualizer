import { cachedBlocks, type CacheSnapshot, type Relation } from '../db/inspector'
import type { PageRef } from './trace'

/**
 * Shared buffers as the query found them, to decide whether each page access
 * was a hit or a read. A page is a hit if it was cached when execution began
 * (the snapshot taken after planning) or the query already read it. Once read,
 * a page stays: the whole database fits in shared buffers, so nothing is
 * evicted during a query (ADR 0022).
 */
export class SharedBuffers {
  /** Pages in buffers now, as "relation/block". */
  private cached = new Set<string>()

  constructor(snapshot: CacheSnapshot, relations: Relation[]) {
    for (const relation of relations) {
      for (const block of cachedBlocks(snapshot, relation)) this.cached.add(key({ relation: relation.oid, block }))
    }
  }

  /** Records an access to a page and returns what it was: a hit, or a read into a buffer. */
  access(page: PageRef): 'buffer.hit' | 'buffer.read' {
    if (this.cached.has(key(page))) return 'buffer.hit'
    this.cached.add(key(page))
    return 'buffer.read'
  }
}

function key(page: PageRef) {
  return `${page.relation}/${page.block}`
}
