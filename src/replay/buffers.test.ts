import { describe, expect, it } from 'vitest'
import type { Relation } from '../db/inspector'
import { SharedBuffers } from './buffers'

const orders: Relation = { oid: 10, schema: 'public', name: 'orders', kind: 'table', accessMethod: 'heap', tableOid: null, pages: 9 }
const pkey: Relation = { oid: 11, schema: 'public', name: 'orders_pkey', kind: 'index', accessMethod: 'btree', tableOid: 10, pages: 3 }

describe('SharedBuffers', () => {
  it('counts a page cached at the start as a hit, and any other page as a read the first time only', () => {
    const buffers = new SharedBuffers(
      {
        pages: [
          { relationOid: 10, fork: 'main', block: 2, bufferId: 1 },
          // Only the main data counts: a visibility map page 5 isn't heap page 5.
          { relationOid: 10, fork: 'vm', block: 5, bufferId: 2 },
          { relationOid: 11, fork: 'main', block: 1, bufferId: 3 },
        ],
      },
      [orders, pkey],
    )
    expect(buffers.access({ relation: 10, block: 2 })).toBe('buffer.hit')
    expect(buffers.access({ relation: 10, block: 5 })).toBe('buffer.read')
    expect(buffers.access({ relation: 10, block: 5 })).toBe('buffer.hit')
    // Index and heap pages are numbered separately.
    expect(buffers.access({ relation: 11, block: 2 })).toBe('buffer.read')
    expect(buffers.access({ relation: 11, block: 1 })).toBe('buffer.hit')
  })
})
