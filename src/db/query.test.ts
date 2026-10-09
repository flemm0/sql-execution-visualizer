import { messages, type PGlite, type Results } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDatabase } from './createDatabase'
import { query, sendQuery } from './query'

let db: PGlite

beforeAll(async () => {
  db = await createDatabase()
})
afterAll(() => db.close())

describe('query', () => {
  it('turns values into JavaScript values, as db.query does', async () => {
    const sql = `
      SELECT 42 AS int, 1.5::float8 AS float, true AS yes, NULL::text AS nothing,
        'hello' AS text, '2026-10-09 12:00:00+00'::timestamptz AS at,
        to_json(ARRAY['autovacuum_enabled=off']) AS options
    `
    const ours = await query<Record<string, unknown>>(db, sql)
    const theirs = await db.query<Record<string, unknown>>(sql)
    expect(ours.rows).toEqual(theirs.rows)
    expect(ours.rows[0]).toEqual({
      int: 42,
      float: 1.5,
      yes: true,
      nothing: null,
      text: 'hello',
      at: new Date('2026-10-09T12:00:00Z'),
      options: ['autovacuum_enabled=off'],
    })
  })

  it('returns the last statement’s result when given several', async () => {
    const result = await query<{ n: number }>(db, 'CREATE TEMP TABLE t (n int); INSERT INTO t VALUES (7); SELECT n FROM t')
    expect(result.rows).toEqual([{ n: 7 }])
  })

  it('throws Postgres’s error, with every field kept', async () => {
    const failure = query(db, 'SELECT nope')
    await expect(failure).rejects.toBeInstanceOf(messages.DatabaseError)
    await expect(failure).rejects.toMatchObject({ message: 'column "nope" does not exist', position: '8', code: '42703' })
  })

  it('waits for a db.query in progress instead of breaking into it', async () => {
    // db.query sends parse, bind and execute as separate messages; PGlite runs
    // one like this on its own at startup. A query sent in between would make
    // Postgres drop the prepared statement ("unnamed prepared statement does not exist").
    // Here, ours is sent right after their first message, and given time to run.
    const send = db.execProtocolStream.bind(db)
    let ours: Promise<Results<{ n: number }>> | undefined
    vi.spyOn(db, 'execProtocolStream').mockImplementationOnce(async (message, options) => {
      const reply = await send(message, options)
      ours = query<{ n: number }>(db, 'SELECT 2 AS n')
      await new Promise((resolve) => setTimeout(resolve, 20))
      return reply
    })
    const theirs = await db.query<{ n: number }>('SELECT $1::int AS n', [1])
    expect(theirs.rows).toEqual([{ n: 1 }])
    expect((await ours!).rows).toEqual([{ n: 2 }])
    vi.restoreAllMocks()
  })

  it('sends the SQL as one simple query message, not through db.query or db.exec', async () => {
    const raw = vi.spyOn(db, 'execProtocolRaw')
    const viaQuery = vi.spyOn(db, 'query')
    const viaExec = vi.spyOn(db, 'exec')
    await query(db, 'SELECT 1')
    await sendQuery(db, 'SELECT 2')
    expect(raw).toHaveBeenCalledTimes(2)
    expect(viaQuery).not.toHaveBeenCalled()
    expect(viaExec).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
