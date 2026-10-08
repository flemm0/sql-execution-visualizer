import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import { ensureSeeded, readSeedInfo } from './seed'

// The browser saves the database in IndexedDB; in Node, PGlite saves it in a directory.
// Either way, every start goes through the same ensureSeeded call as db.worker.ts.
describe('a saved database', () => {
  let dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'sql-execution-visualizer-'))
  })
  afterAll(() => rm(dataDir, { recursive: true, force: true }))

  it('is seeded on the first start, then reopened with the learner’s changes intact', async () => {
    const first = await createDatabase({ dataDir })
    await ensureSeeded(first)
    const seed = await readSeedInfo(first)
    expect(seed).not.toBeNull()
    await first.exec(`
      CREATE INDEX order_items_product_id_idx ON order_items (product_id);
      CREATE TABLE notes (body text);
      INSERT INTO notes VALUES ('hello');
    `)
    await first.close()

    const second = await createDatabase({ dataDir })
    await ensureSeeded(second)
    expect(await readSeedInfo(second)).toEqual(seed)
    const index = await second.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'order_items_product_id_idx'`)
    expect(index.rows).toHaveLength(1)
    const notes = await second.query<{ body: string }>('SELECT body FROM notes')
    expect(notes.rows).toEqual([{ body: 'hello' }])
    await second.close()
  }, 120_000)
})
