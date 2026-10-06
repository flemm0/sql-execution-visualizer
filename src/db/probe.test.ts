import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './createDatabase'
import { probeDatabase, type ProbeReport } from './probe'

describe('probeDatabase', () => {
  let db: Awaited<ReturnType<typeof createDatabase>>
  let report: ProbeReport

  beforeAll(async () => {
    db = await createDatabase()
    report = await probeDatabase(db)
  })
  afterAll(() => db.close())

  it('runs Postgres 18', () => {
    expect(report.version).toMatch(/^PostgreSQL 18\./)
  })

  it('reads the B-tree metapage and heap line pointers with pageinspect', () => {
    expect(report.btree.rootPage).toBeGreaterThan(0)
    expect(report.btree.levels).toBe(2)
    expect(report.heapPage0[0]).toMatchObject({ lp: 1, ctid: '(0,1)' })
  })

  it('reads pages from disk after the cache is emptied', () => {
    expect(report.lookup).toMatchObject({ nodeType: 'Index Scan', indexName: 'm0_demo_pkey' })
    expect(report.lookup.sharedReadBlocks).toBeGreaterThan(0)
  })
})
