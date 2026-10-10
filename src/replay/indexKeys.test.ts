import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/createDatabase'
import { findRelations, readBtreePages, readIndexColumns, type IndexColumn } from '../db/inspector'
import { readKey } from './indexKeys'
import { Unsupported } from './unsupported'

function column(type: string): IndexColumn {
  return { name: 'c', type, isKey: true, collation: null, descending: false, nullsFirst: false, defaultOrder: true }
}

describe('readKey', () => {
  it('reads an integer, padded to 8 bytes as Postgres stores it', () => {
    // 367 as a 4-byte little-endian integer.
    expect(readKey('6f 01 00 00 00 00 00 00', false, [column('int4')], 1)).toEqual(['(367)'])
    expect(readKey('ff ff ff ff 00 00 00 00', false, [column('int4')], 1)).toEqual(['(-1)'])
  })

  it('starts each value at a multiple of its alignment: a bigint after an integer skips 4 bytes', () => {
    const bytes = '01 00 00 00 00 00 00 00 0a 00 00 00 00 00 00 00'
    expect(readKey(bytes, false, [column('int4'), column('int8')], 2)).toEqual(['(1)', '(10)'])
  })

  it('reads only the columns asked for: a high key may keep fewer than the index has', () => {
    expect(readKey('ea 00 00 00 00 00 00 00', false, [column('int4'), column('date')], 1)).toEqual(['(234)'])
    expect(readKey('', false, [column('int4')], 0)).toEqual([])
  })

  it('reads text with a 1-byte header, which needs no alignment, then the next value', () => {
    // 0x13 = 9 bytes with the header: "Anderson". Then 0x0b = 5 bytes: "Kofi".
    const bytes = '13 41 6e 64 65 72 73 6f 6e 0b 4b 6f 66 69 00 00'
    expect(readKey(bytes, false, [column('text'), column('text')], 2)).toEqual(["'Anderson'", "'Kofi'"])
    // A quote in the text is doubled, as SQL writes it: 0x0b = 5 bytes, "O'Ne".
    expect(readKey('0b 4f 27 4e 65', false, [column('varchar')], 1)).toEqual(["'O''Ne'"])
  })

  it('reads text with a 4-byte header, after padding to 4 bytes', () => {
    const text = 'x'.repeat(200)
    // An integer with a 1-byte header text can't follow without padding; here a
    // 1-byte bool is followed by 3 zero bytes, then the 4-byte header: (204 << 2) little-endian.
    const header = (204 << 2).toString(16).padStart(8, '0')
    const headerBytes = header.match(/../g)?.reverse().join(' ')
    const bytes = `01 00 00 00 ${headerBytes} ${' 78'.repeat(200).trim()}`
    expect(readKey(bytes, false, [column('bool'), column('text')], 2)).toEqual(['true', `'${text}'`])
  })

  it('writes dates and timestamps as days and microseconds since 2000-01-01', () => {
    expect(readKey('26 22 00 00', false, [column('date')], 1)).toEqual([`(DATE '2000-01-01' + 8742)`])
    expect(readKey('ff ff ff 7f', false, [column('date')], 1)).toEqual([`'infinity'::date`])
    // 1 day, 1 second and 1 microsecond.
    const microseconds = (86_400_000_000n + 1_000_001n).toString(16).padStart(16, '0')
    const bytes = microseconds.match(/../g)?.reverse().join(' ') as string
    expect(readKey(bytes, false, [column('timestamp')], 1)).toEqual([
      `(TIMESTAMP '2000-01-01' + make_interval(days => 1, secs => 1.000001))`,
    ])
    expect(readKey(bytes, false, [column('timestamptz')], 1)).toEqual([
      `((TIMESTAMP '2000-01-01' + make_interval(days => 1, secs => 1.000001)) AT TIME ZONE 'UTC')`,
    ])
  })

  it('reads NULL when every column is NULL, but can’t tell which ones are when only some are', () => {
    expect(readKey('', true, [column('int4'), column('int4')], 2)).toEqual([null, null])
    expect(() => readKey('01 00 00 00', true, [column('int4'), column('int4')], 2)).toThrow(Unsupported)
  })

  it('says which types it can’t read', () => {
    expect(() => readKey('00 00', false, [column('numeric')], 1)).toThrow(
      'Animation isn’t available yet for indexes on numeric columns.',
    )
  })
})

describe('readKey on real index pages', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await createDatabase()
    await db.exec(`
      CREATE TABLE keys (n int, big bigint, small int2, flag bool, day date, at timestamp, at_tz timestamptz, word text, code varchar(30));
      INSERT INTO keys
      SELECT n, n * 10000000000 - 7, (n % 300 - 150)::int2, n % 2 = 0, DATE '1999-12-25' + n * 3,
        TIMESTAMP '1999-12-31 22:00:00.123456' + n * INTERVAL '1 hour 1.5 seconds',
        TIMESTAMPTZ '1999-12-31 23:00:00.000001+02' + n * INTERVAL '1 day 3 seconds',
        repeat('ü', n % 5) || n || '''s', 'code-' || (n * 7)
      FROM generate_series(1, 400) AS n;
      INSERT INTO keys VALUES (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
      CREATE INDEX keys_all ON keys (n, big, small, flag, day, at, at_tz, word, code);
    `)
  }, 120_000)
  afterAll(() => db.close())

  it('reads back every column of every entry, as Postgres writes the values in the row', async () => {
    const relations = await findRelations(db, [{ schema: 'public', name: 'keys' }])
    const index = relations.find((relation) => relation.name === 'keys_all')
    if (!index) throw new Error('no index')
    const columns = await readIndexColumns(db, index)
    const blocks = Array.from({ length: index.pages - 1 }, (_, i) => i + 1)
    const pages = await readBtreePages(db, index, blocks)
    const entries = pages.flatMap((page) => page.items.filter((item) => item.role === 'entry'))
    expect(entries).toHaveLength(401)

    // Each entry's values, evaluated by Postgres, next to its row's own values.
    const rows = entries.map((entry) => {
      const values = readKey(entry.keyBytes, entry.hasNulls, columns, columns.length)
      const cast = values.map((value, i) => `CAST(${value ?? 'NULL'} AS ${columns[i].type})::text`)
      return `SELECT '(${entry.heapTids[0].block},${entry.heapTids[0].offset})'::tid AS tid, ARRAY[${cast.join(', ')}] AS decoded`
    })
    const compared = await db.query<{ decoded: (string | null)[]; actual: (string | null)[] }>(`
      SELECT decoded, ARRAY[n::text, big::text, small::text, flag::text, day::text, at::text, at_tz::text, word, code::text] AS actual
      FROM (${rows.join(' UNION ALL ')}) AS d JOIN keys ON keys.ctid = d.tid
    `)
    expect(compared.rows).toHaveLength(401)
    for (const row of compared.rows) expect(row.decoded).toEqual(row.actual)
  })
})
