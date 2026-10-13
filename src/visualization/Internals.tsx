import type { LinePointer, VisibilityBits } from '../replay/trace'

/*
 * What "Show internals" adds (docs/UX.md#visualization): line pointers,
 * tuple headers and visibility map bits, as Postgres read them. Shared by
 * the heap zone and the page browser. Internals are drawn in neutral
 * colors: the accent colors keep their meanings.
 */

const integer = new Intl.NumberFormat('en-US')

/** A status word as hex, as Postgres's headers write them: 0x0902. */
export function hex(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`
}

/** A line pointer and its tuple's header on one line: "lp 4 → byte 7840, 157 bytes · xmin 731 · xmax 0 · …". */
export function LinePointerText({ lp }: { lp: LinePointer }) {
  return (
    <span className="text-fg-muted" data-testid="internals-lp" data-state={lp.state}>
      lp {lp.offset}: {linePointerText(lp)}
      {lp.header && (
        <>
          {' · '}
          <span data-testid="internals-xmin">xmin {lp.header.xmin}</span>
          {' · '}
          <span data-testid="internals-xmax">xmax {lp.header.xmax}</span>
          {` · t_ctid (${lp.header.ctid.block},${lp.header.ctid.offset}) · `}
          <span data-testid="internals-infomask" title="t_infomask and t_infomask2, with the names Postgres gives their bits (heap_tuple_infomask_flags)">
            infomask {hex(lp.header.infomask)} infomask2 {hex(lp.header.infomask2)}
            {lp.header.flags.length > 0 && ` ${lp.header.flags.join(' ')}`}
            {lp.header.combinedFlags.length > 0 && ` (${lp.header.combinedFlags.join(' ')})`}
          </span>
        </>
      )}
    </span>
  )
}

/** Where a line pointer points. */
function linePointerText(lp: LinePointer): string {
  switch (lp.state) {
    case 'normal':
      return lp.tupleStart === null ? 'normal, no storage' : `tuple at byte ${integer.format(lp.tupleStart)}, ${integer.format(lp.length)} bytes`
    case 'redirect':
      return `redirect → lp ${lp.redirectTo}`
    case 'dead':
      return 'dead'
    case 'unused':
      return 'unused'
  }
}

/** A page's two bits in the visibility map, or that the map doesn't cover it. */
export function VisibilityText({ bits }: { bits: VisibilityBits | null }) {
  return (
    <span data-testid="internals-vm">
      {bits === null
        ? 'visibility map: no bits for this page yet (the table hasn’t been vacuumed since it was added), so not all-visible'
        : `visibility map: all-visible ${bits.allVisible ? '1' : '0'} · all-frozen ${bits.allFrozen ? '1' : '0'}`}
    </span>
  )
}

/** A heap page's header: how many line pointers it has, and the free space between them and the tuples. */
export function PageHeaderText({ lower, upper, linePointers }: { lower: number; upper: number; linePointers: number | null }) {
  return (
    <span data-testid="internals-header">
      {linePointers !== null && `${integer.format(linePointers)} line ${linePointers === 1 ? 'pointer' : 'pointers'} · `}
      free space from byte {integer.format(lower)} (pd_lower) to {integer.format(upper)} (pd_upper)
    </span>
  )
}
