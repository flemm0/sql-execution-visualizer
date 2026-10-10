import type { IndexColumn } from '../db/inspector'
import { quoteLiteral } from '../db/sql'
import { Unsupported } from './unsupported'

/*
 * Reads the key values out of a B-tree item's bytes (bt_page_items' "data"),
 * so the replay can ask Postgres how they compare with a scan's conditions.
 * Each value comes back as a SQL expression, e.g. "4242" or "'Smith'", that
 * the caller casts to the column's type.
 *
 * The bytes are laid out as Postgres stores a row (heap_fill_tuple): each
 * column in turn, starting at a multiple of its type's alignment. PGlite is
 * WebAssembly, which is little-endian and aligns 8-byte values to 8 bytes.
 */

/** How a type is stored, and how to write a stored value as SQL. */
interface StoredType {
  /** Its size in bytes, or -1 for a variable-length type (text). */
  length: number
  /** Where a value may start: at a multiple of this many bytes. */
  align: number
  /** The value at `offset`, as a SQL expression. `length` is its size (for variable-length types, its data's). */
  toSql: (bytes: DataView, offset: number, length: number) => string
}

const INT32_MAX = 2147483647
const INT32_MIN = -2147483648
const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n
const MICROSECONDS_PER_DAY = 86_400_000_000n

const TEXT: StoredType = {
  length: -1,
  align: 4,
  toSql: (bytes, offset, length) =>
    quoteLiteral(new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length))),
}

/** The types whose keys can be read. Others make the query unsupported. */
const STORED_TYPES: Record<string, StoredType> = {
  bool: { length: 1, align: 1, toSql: (bytes, offset) => (bytes.getUint8(offset) !== 0 ? 'true' : 'false') },
  int2: { length: 2, align: 2, toSql: (bytes, offset) => `(${bytes.getInt16(offset, true)})` },
  int4: { length: 4, align: 4, toSql: (bytes, offset) => `(${bytes.getInt32(offset, true)})` },
  int8: { length: 8, align: 8, toSql: (bytes, offset) => `(${bytes.getBigInt64(offset, true)})` },
  oid: { length: 4, align: 4, toSql: (bytes, offset) => `${bytes.getUint32(offset, true)}` },
  // Days since 2000-01-01.
  date: { length: 4, align: 4, toSql: (bytes, offset) => dateSql(bytes.getInt32(offset, true)) },
  // Microseconds since 2000-01-01 00:00 (in UTC, for timestamptz).
  timestamp: { length: 8, align: 8, toSql: (bytes, offset) => timestampSql(bytes.getBigInt64(offset, true)) },
  timestamptz: {
    length: 8,
    align: 8,
    toSql: (bytes, offset) => {
      const value = bytes.getBigInt64(offset, true)
      if (value === INT64_MAX || value === INT64_MIN) return timestampSql(value)
      return `(${timestampSql(value)} AT TIME ZONE 'UTC')`
    },
  },
  text: TEXT,
  varchar: TEXT,
}

/** Whether keys of this type (a pg_type name) can be read. */
export function canReadKeys(type: string): boolean {
  return type in STORED_TYPES
}

/**
 * The first `count` key values stored in a B-tree item, as SQL expressions,
 * or null for NULL. `columns` are the index's columns; `keyBytes` and
 * `hasNulls` come from bt_page_items.
 */
export function readKey(keyBytes: string, hasNulls: boolean, columns: IndexColumn[], count: number): (string | null)[] {
  const bytes = parseHex(keyBytes)
  if (hasNulls) {
    // bt_page_items leaves out the bitmap that says which columns are NULL.
    // With no bytes at all, they all are.
    if (bytes.byteLength === 0) return Array<null>(count).fill(null)
    throw new Unsupported('Animation isn’t available yet for multi-column indexes with NULLs in some columns.')
  }

  const values: string[] = []
  let offset = 0
  for (const column of columns.slice(0, count)) {
    const type = STORED_TYPES[column.type]
    if (type === undefined) throw new Unsupported(`Animation isn’t available yet for indexes on ${column.type} columns.`)
    if (type.length === -1) {
      // A short text value has a 1-byte header and starts anywhere; a zero
      // byte is padding before a value with a 4-byte header.
      if (bytes.getUint8(offset) === 0) offset = alignUp(offset, type.align)
      const { headerLength, dataLength } = varlenaHeader(bytes, offset)
      values.push(type.toSql(bytes, offset + headerLength, dataLength))
      offset += headerLength + dataLength
    } else {
      offset = alignUp(offset, type.align)
      values.push(type.toSql(bytes, offset, type.length))
      offset += type.length
    }
  }
  return values
}

/**
 * A variable-length value's header (postgres.h, varatt.h): 1 byte with the
 * low bit set for values under 127 bytes, otherwise 4 bytes with the length
 * in the upper 30 bits. Compressed and out-of-line values aren't read.
 */
function varlenaHeader(bytes: DataView, offset: number) {
  const first = bytes.getUint8(offset)
  if ((first & 1) === 1) {
    if (first === 1) throw new Unsupported('Animation isn’t available yet for index keys stored out of line.')
    // The length counts the header.
    return { headerLength: 1, dataLength: (first >> 1) - 1 }
  }
  const header = bytes.getUint32(offset, true)
  if ((header & 3) !== 0) throw new Unsupported('Animation isn’t available yet for compressed index keys.')
  return { headerLength: 4, dataLength: (header >>> 2) - 4 }
}

function dateSql(days: number) {
  if (days === INT32_MAX) return `'infinity'::date`
  if (days === INT32_MIN) return `'-infinity'::date`
  return `(DATE '2000-01-01' + ${days})`
}

function timestampSql(microseconds: bigint) {
  if (microseconds === INT64_MAX) return `'infinity'::timestamp`
  if (microseconds === INT64_MIN) return `'-infinity'::timestamp`
  // Whole days, and the rest in seconds with 6 decimals, so nothing is rounded.
  const days = microseconds / MICROSECONDS_PER_DAY
  const rest = microseconds % MICROSECONDS_PER_DAY
  const sign = rest < 0n ? '-' : ''
  const magnitude = rest < 0n ? -rest : rest
  const seconds = `${sign}${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n).padStart(6, '0')}`
  return `(TIMESTAMP '2000-01-01' + make_interval(days => ${days}, secs => ${seconds}))`
}

function alignUp(offset: number, align: number) {
  return Math.ceil(offset / align) * align
}

/** Bytes written as bt_page_items writes them, e.g. "6f 01 00 00". */
function parseHex(hex: string): DataView {
  const pairs = hex.trim() === '' ? [] : hex.trim().split(/\s+/)
  return new DataView(Uint8Array.from(pairs, (pair) => parseInt(pair, 16)).buffer)
}
