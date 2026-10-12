import type { CacheSnapshot, Relation } from '../db/inspector'
import type { PageRef } from './trace'

/**
 * Shared buffers as the query found them, to decide whether each page access
 * was a hit or a read. A page is a hit if it was cached when execution began
 * (the snapshot taken after planning) or the query already read it. Once read,
 * a page stays: the whole database fits in shared buffers, so nothing is
 * evicted during a query (ADR 0022).
 */
export class SharedBuffers {
  /** Pages in buffers now, as "relation/fork/block". */
  private cached = new Set<string>()

  constructor(snapshot: CacheSnapshot, relations: Relation[]) {
    const oids = new Set(relations.map((relation) => relation.oid))
    for (const page of snapshot.pages) {
      if (!oids.has(page.relationOid)) continue
      // Replays read a relation's own pages and a table's visibility map.
      if (page.fork === 'main') this.cached.add(key({ relation: page.relationOid, block: page.block }))
      if (page.fork === 'vm') this.cached.add(key({ relation: page.relationOid, block: page.block, fork: 'vm' }))
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
  return `${page.relation}/${page.fork ?? 'main'}/${page.block}`
}
