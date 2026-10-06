import type { PGliteInterface } from '@electric-sql/pglite'

/** M0's proof that real Postgres internals can be read in the browser. */
export interface ProbeReport {
  /** e.g. "PostgreSQL 18.3 (PGlite 0.5.8)" */
  version: string
  /** From the metapage of the demo table's primary-key B-tree. */
  btree: { rootPage: number; levels: number }
  /** The first line pointers on heap page 0 of the demo table. */
  heapPage0: HeapItem[]
  /** EXPLAIN (ANALYZE, BUFFERS) of a primary-key lookup, run after emptying the cache. */
  lookup: { nodeType: string; indexName: string; sharedHitBlocks: number; sharedReadBlocks: number }
}

export interface HeapItem {
  lp: number
  lpOff: number
  lpLen: number
  ctid: string
}

interface ExplainPlan {
  'Node Type': string
  'Index Name'?: string
  'Shared Hit Blocks': number
  'Shared Read Blocks': number
}

export async function probeDatabase(db: PGliteInterface): Promise<ProbeReport> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS m0_demo (id int PRIMARY KEY, payload text);
    INSERT INTO m0_demo
      SELECT g, repeat('x', 200) FROM generate_series(1, 5000) AS g
      ON CONFLICT DO NOTHING;
    ANALYZE m0_demo;
  `)

  const version = await db.query<{ version: string }>('SELECT version()')
  const metapage = await db.query<{ root: number; level: number }>(
    `SELECT root, level FROM bt_metap('m0_demo_pkey')`,
  )
  const heapPage0 = await db.query<HeapItem>(`
    SELECT lp, lp_off AS "lpOff", lp_len AS "lpLen", t_ctid::text AS ctid
    FROM heap_page_items(get_raw_page('m0_demo', 0))
    ORDER BY lp
    LIMIT 5
  `)

  // Empty the cache for the table and its index, so the lookup has to read pages from disk.
  await db.exec(`
    SELECT pg_buffercache_evict_relation('m0_demo');
    SELECT pg_buffercache_evict_relation('m0_demo_pkey');
  `)
  const explain = await db.query<{ 'QUERY PLAN': { Plan: ExplainPlan }[] }>(
    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM m0_demo WHERE id = 42',
  )
  const plan = explain.rows[0]['QUERY PLAN'][0].Plan

  return {
    version: version.rows[0].version.split(' on ')[0],
    // The metapage stores the root's level, counting leaves as level 0.
    btree: { rootPage: metapage.rows[0].root, levels: metapage.rows[0].level + 1 },
    heapPage0: heapPage0.rows,
    lookup: {
      nodeType: plan['Node Type'],
      indexName: plan['Index Name'] ?? '',
      sharedHitBlocks: plan['Shared Hit Blocks'],
      sharedReadBlocks: plan['Shared Read Blocks'],
    },
  }
}
