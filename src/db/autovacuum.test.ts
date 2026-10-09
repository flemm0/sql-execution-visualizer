import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assessTable,
  readAutovacuumSettings,
  readTableActivity,
  runAutovacuum,
  flushStatistics,
  type AutovacuumSettings,
  type TableActivity,
} from './autovacuum'
import { createDatabase } from './createDatabase'
import { inTransaction, runStatementAt } from './runner'
import { seedDatabase } from './seed'

/** Postgres 18's defaults (postgresql.conf). */
const DEFAULTS: AutovacuumSettings = {
  vacuumThreshold: 50,
  vacuumScaleFactor: 0.2,
  vacuumMaxThreshold: 100_000_000,
  insertThreshold: 1000,
  insertScaleFactor: 0.2,
  analyzeThreshold: 50,
  analyzeScaleFactor: 0.1,
}

/** A 50,000-row table with nothing changed, plus whatever the test overrides. */
function table(overrides: Partial<TableActivity> = {}): TableActivity {
  return {
    schema: 'public',
    name: 'orders',
    estimatedRows: 50_000,
    pages: 600,
    allFrozenPages: 0,
    deadRows: 0,
    insertedSinceVacuum: 0,
    changedSinceAnalyze: 0,
    lastVacuum: null,
    lastAnalyze: null,
    options: {},
    ...overrides,
  }
}

describe('autovacuum thresholds', () => {
  it('analyzes when more than 50 + 10% of the rows changed', () => {
    expect(assessTable(table({ changedSinceAnalyze: 5050 }), DEFAULTS)).toMatchObject({
      changedRows: { count: 5050, threshold: 5050 },
      analyze: false,
    })
    expect(assessTable(table({ changedSinceAnalyze: 5051 }), DEFAULTS).analyze).toBe(true)
  })

  it('vacuums when dead rows pass 50 + 20% of the rows', () => {
    const assessment = assessTable(table({ deadRows: 10_051 }), DEFAULTS)
    expect(assessment.deadRows.threshold).toBe(10_050)
    expect(assessment).toMatchObject({ vacuum: true, analyze: false })
    expect(assessTable(table({ deadRows: 10_050 }), DEFAULTS).vacuum).toBe(false)
  })

  it('vacuums when inserts pass 1,000 + 20% of the not-yet-frozen rows', () => {
    expect(assessTable(table({ insertedSinceVacuum: 11_001 }), DEFAULTS).vacuum).toBe(true)
    // With half the pages frozen, only the other half counts: 1,000 + 20% of 25,000.
    const halfFrozen = table({ allFrozenPages: 300, insertedSinceVacuum: 6001 })
    expect(assessTable(halfFrozen, DEFAULTS)).toMatchObject({ insertedRows: { threshold: 6000 }, vacuum: true })
  })

  it('caps the dead-row threshold at autovacuum_vacuum_max_threshold', () => {
    const capped = { ...DEFAULTS, vacuumMaxThreshold: 1000 }
    expect(assessTable(table({ deadRows: 1001 }), capped)).toMatchObject({ deadRows: { threshold: 1000 }, vacuum: true })
  })

  it('treats a table that was never vacuumed or analyzed as empty', () => {
    const fresh = assessTable(table({ estimatedRows: -1, changedSinceAnalyze: 51 }), DEFAULTS)
    expect(fresh).toMatchObject({ changedRows: { threshold: 50 }, deadRows: { threshold: 50 }, analyze: true })
  })

  it('uses a table’s own storage parameters over the server settings', () => {
    const options = { autovacuum_analyze_scale_factor: '0.01', autovacuum_vacuum_insert_threshold: '-1' }
    const assessment = assessTable(table({ options, changedSinceAnalyze: 551, insertedSinceVacuum: 1_000_000 }), DEFAULTS)
    expect(assessment).toMatchObject({ changedRows: { threshold: 550 }, insertedRows: null, analyze: true, vacuum: false })
  })

  it('leaves a table alone when its autovacuum_enabled is off', () => {
    for (const value of ['off', 'false', 'no', '0', 'f']) {
      const assessment = assessTable(table({ options: { autovacuum_enabled: value }, deadRows: 1e6, changedSinceAnalyze: 1e6 }), DEFAULTS)
      expect(assessment, value).toMatchObject({ enabled: false, vacuum: false, analyze: false })
    }
    expect(assessTable(table({ options: { autovacuum_enabled: 'on' }, deadRows: 1e6 }), DEFAULTS).vacuum).toBe(true)
  })
})

describe('the autovacuum simulator on a seeded database', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await createDatabase()
    await seedDatabase(db)
  }, 120_000)
  afterAll(() => db.close())

  async function activity(name: string) {
    await flushStatistics(db)
    return (await readTableActivity(db)).find((table) => table.name === name)
  }

  it('reads Postgres 18’s default settings', async () => {
    expect(await readAutovacuumSettings(db)).toEqual(DEFAULTS)
  })

  it('has nothing to do right after seeding', async () => {
    expect(await runAutovacuum(db)).toEqual([])
  })

  it('sees writes made a moment ago and analyzes once enough rows changed', async () => {
    // 5,050 changed rows is exactly the threshold for orders: not yet.
    await db.exec(`UPDATE orders SET status = 'shipped' WHERE id <= 5050`)
    expect(await runAutovacuum(db)).toEqual([])
    expect((await activity('orders'))?.changedSinceAnalyze).toBe(5050)

    await db.exec(`UPDATE orders SET status = 'delivered' WHERE id = 5051`)
    const actions = await runAutovacuum(db)
    expect(actions).toMatchObject([
      { schema: 'public', table: 'orders', analyzed: true, vacuumed: false, assessment: { changedRows: { count: 5051 } } },
    ])
    const after = await activity('orders')
    expect(after?.changedSinceAnalyze).toBe(0)
    expect(after?.lastAnalyze).toBeInstanceOf(Date)
  })

  it('vacuums and analyzes a new table in one pass after many inserts', async () => {
    await db.exec(`CREATE TABLE events (id int); INSERT INTO events SELECT generate_series(1, 1001)`)
    expect(await runAutovacuum(db)).toMatchObject([{ table: 'events', vacuumed: true, analyzed: true }])
    const after = await activity('events')
    expect(after).toMatchObject({ estimatedRows: 1001, insertedSinceVacuum: 0, changedSinceAnalyze: 0 })
    expect(after?.lastVacuum).toBeInstanceOf(Date)
  })

  it('removes dead rows once there are enough of them', async () => {
    // events now has 1,001 rows: the vacuum threshold is 50 + 20% = 250.
    await db.exec(`DELETE FROM events WHERE id <= 251`)
    expect(await runAutovacuum(db)).toMatchObject([{ table: 'events', vacuumed: true, analyzed: true }])
    expect((await activity('events'))?.deadRows).toBe(0)
  })

  it('skips tables with autovacuum_enabled off, and temporary tables', async () => {
    await db.exec(`
      CREATE TABLE quiet (id int) WITH (autovacuum_enabled = off);
      INSERT INTO quiet SELECT generate_series(1, 2000);
      CREATE TEMP TABLE scratch AS SELECT generate_series(1, 2000) AS id;
    `)
    expect(await runAutovacuum(db)).toEqual([])
  })
})

describe('checking for an open transaction', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await createDatabase()
  })
  afterAll(() => db.close())

  it('tells idle, open and failed transactions apart', async () => {
    expect(await inTransaction(db)).toBe(false)
    await runStatementAt(db, 'BEGIN', 0)
    expect(await inTransaction(db)).toBe(true)
    await runStatementAt(db, 'SELECT 1 / 0', 0)
    expect(await inTransaction(db)).toBe(true)
    await runStatementAt(db, 'ROLLBACK', 0)
    expect(await inTransaction(db)).toBe(false)
  })
})
