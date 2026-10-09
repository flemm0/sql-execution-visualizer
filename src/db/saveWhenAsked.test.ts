import { protocol, type PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { runAutovacuum } from './autovacuum'
import { loadCatalog, postgresVersion } from './catalog'
import { createDatabase } from './createDatabase'
import { inTransaction, runAll } from './runner'
import { saveWhenAsked } from './saveWhenAsked'
import { readSeedInfo } from './seed'

// In the browser, PGlite's worker proxy runs each page's query by calling one of
// four methods on the object db.worker.ts returns. These tests call the same four
// methods on that object, and count saves by watching PGlite's syncToFs.

let db: PGlite
let shared: PGlite
let saves: MockInstance

beforeAll(async () => {
  db = await createDatabase()
  shared = saveWhenAsked(db)
  saves = vi.spyOn(db, 'syncToFs')
})
afterAll(async () => {
  saves.mockRestore()
  await db.close()
})
beforeEach(() => {
  saves.mockClear()
})

const query = (sql: string) => protocol.serialize.query(sql)

describe('the database the worker shares with the pages', () => {
  it('runs queries sent as raw protocol messages without saving', async () => {
    const reply = await shared.execProtocolRaw(query('SELECT 42'))
    expect(new TextDecoder().decode(reply)).toContain('42')
    expect(saves).not.toHaveBeenCalled()
  })

  it('runs queries through execProtocol and execProtocolStream without saving', async () => {
    const { messages } = await shared.execProtocol(query('SELECT 1'))
    expect(messages.some((message) => message.name === 'dataRow')).toBe(true)
    const streamed = await shared.execProtocolStream(query('SELECT 2'))
    expect(streamed.some((message) => message.name === 'dataRow')).toBe(true)
    expect(saves).not.toHaveBeenCalled()
  })

  it('runs writes without saving them; the next query sees them', async () => {
    await shared.execProtocolRaw(query("CREATE TABLE notes (body text); INSERT INTO notes VALUES ('hello')"))
    const reply = await shared.execProtocolRaw(query('SELECT body FROM notes'))
    expect(new TextDecoder().decode(reply)).toContain('hello')
    expect(saves).not.toHaveBeenCalled()
  })

  it('runs everything the app does in a run without saving: statements, autovacuum, the catalog reload', async () => {
    const results = await runAll(
      shared,
      'CREATE TABLE items (id int PRIMARY KEY);\nINSERT INTO items SELECT generate_series(1, 2000);\nSELECT count(*) FROM items;',
    )
    expect(results.map((result) => result.status)).toEqual(['done', 'done', 'rows'])
    expect(await inTransaction(shared)).toBe(false)
    // 2,000 new rows cross the insert threshold, so this vacuums and analyzes.
    expect(await runAutovacuum(shared)).toHaveLength(1)
    expect((await loadCatalog(shared)).schemas[0].tables[0].name).toBe('items')
    expect(await readSeedInfo(shared)).toBeNull()
    expect(await postgresVersion(shared)).toMatch(/^PostgreSQL 18/)
    expect(saves).not.toHaveBeenCalled()
  })

  it('saves when a page asks it to, and waits until the save is done', async () => {
    let finished = false
    saves.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      finished = true
    })
    await shared.syncToFs()
    expect(saves).toHaveBeenCalledTimes(1)
    expect(finished).toBe(true)
  })

  it('leaves the database itself saving after every query, as the seeding in the worker needs', async () => {
    await db.execProtocolRaw(query('SELECT 1'))
    await db.exec('SELECT 1')
    expect(saves).toHaveBeenCalledTimes(2)
  })

  // Last: after execProtocolRawStream, PGlite keeps sending replies to its
  // onRawData callback instead of returning them, until a query resets it.
  it('runs queries through execProtocolRawStream without saving', async () => {
    const chunks: Uint8Array[] = []
    await shared.execProtocolRawStream(query('SELECT 3'), { onRawData: (data) => chunks.push(data) })
    expect(chunks.length).toBeGreaterThan(0)
    expect(saves).not.toHaveBeenCalled()
  })
})
