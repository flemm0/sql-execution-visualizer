/**
 * The execution plan from `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`,
 * reshaped for the plan tree. Every number comes straight from Postgres.
 */

export interface Plan {
  root: PlanNode
  planningMs: number
  /**
   * Pages the planner found in shared buffers (hits) or read into them (reads):
   * system catalogs, an index's metapage, and index probes for ranges near a
   * column's minimum or maximum. Not part of any node's counts.
   */
  planningHit: number
  planningRead: number
  executionMs: number
  /** The JSON Postgres returned, kept whole for the replay engine (M2). */
  raw: unknown
}

/** What planning a query took, from `EXPLAIN (BUFFERS, SUMMARY, FORMAT JSON)`. */
export interface Planning {
  planningMs: number
  planningHit: number
  planningRead: number
}

/** A table a plan reads, e.g. { schema: "public", name: "orders" }. */
export interface TableName {
  schema: string
  name: string
}

export interface PlanNode {
  /** The node's heading in Postgres's text EXPLAIN, e.g. "Index Scan using orders_pkey on orders". */
  title: string
  /** The node type alone, e.g. "Index Scan". */
  nodeType: string
  /** The planner's row estimate, per loop. */
  estimatedRows: number
  /** Rows the node actually produced, per loop (an average when loops > 1, so it can be fractional). */
  actualRows: number
  loops: number
  /** Pages found in shared buffers (hits) and read into them (reads), this node and its children together. */
  sharedHit: number
  sharedRead: number
  /** Time until the node's last row, in milliseconds, per loop. */
  totalTimeMs: number
  /** Conditions and counters, e.g. { label: "Index Cond", value: "(orders.id = 4242)" }. */
  details: { label: string; value: string }[]
  children: PlanNode[]
}

/** The JSON fields of one plan node that are used here. Postgres sends more. */
interface JsonPlanNode {
  'Node Type': string
  'Plan Rows': number
  'Actual Rows': number
  'Actual Loops': number
  'Actual Total Time': number
  'Shared Hit Blocks': number
  'Shared Read Blocks': number
  Plans?: JsonPlanNode[]
  [field: string]: unknown
}

interface JsonExplain {
  Plan: JsonPlanNode
  /** Only with SUMMARY, which ANALYZE turns on. */
  'Planning Time'?: number
  'Execution Time'?: number
  /** Only with BUFFERS. */
  Planning?: { 'Shared Hit Blocks': number; 'Shared Read Blocks': number }
}

/** Fields shown under a node, in this order, when Postgres includes them. */
const DETAIL_FIELDS = [
  'Index Cond',
  'Recheck Cond',
  'Hash Cond',
  'Merge Cond',
  'Join Filter',
  'Filter',
  'Rows Removed by Index Recheck',
  'Rows Removed by Join Filter',
  'Rows Removed by Filter',
  'Index Searches',
  'Heap Fetches',
  'Exact Heap Blocks',
  'Lossy Heap Blocks',
  'Sort Key',
  'Sort Method',
  'Group Key',
  'Presorted Key',
]

/**
 * Counters text EXPLAIN leaves out when they're zero (FORMAT JSON always
 * includes them), so the tree shows what psql would.
 */
const HIDDEN_WHEN_ZERO = new Set([
  'Rows Removed by Index Recheck',
  'Rows Removed by Join Filter',
  'Rows Removed by Filter',
  'Exact Heap Blocks',
  'Lossy Heap Blocks',
])

/** Reads the single row `EXPLAIN (FORMAT JSON)` returns: a one-element array. */
export function parsePlan(explainJson: unknown): Plan {
  const [explain] = explainJson as JsonExplain[]
  return {
    root: parseNode(explain.Plan),
    ...parsePlanning(explainJson),
    executionMs: explain['Execution Time'] ?? 0,
    raw: explainJson,
  }
}

/** Reads planning's time and buffer counts from the row `EXPLAIN (BUFFERS, SUMMARY, FORMAT JSON)` returns. */
export function parsePlanning(explainJson: unknown): Planning {
  const [explain] = explainJson as JsonExplain[]
  return {
    planningMs: explain['Planning Time'] ?? 0,
    planningHit: explain.Planning?.['Shared Hit Blocks'] ?? 0,
    planningRead: explain.Planning?.['Shared Read Blocks'] ?? 0,
  }
}

/**
 * The tables a plan reads, each once, from the row `EXPLAIN (VERBOSE, FORMAT JSON)`
 * returns (VERBOSE adds each table's schema). Views don't appear: the planner
 * replaces a view with its query, so the plan reads the tables underneath.
 */
export function tablesInPlan(explainJson: unknown): TableName[] {
  const [explain] = explainJson as JsonExplain[]
  const tables = new Map<string, TableName>()
  const visit = (node: JsonPlanNode) => {
    const name = node['Relation Name']
    const schema = node['Schema']
    if (typeof name === 'string' && typeof schema === 'string') tables.set(JSON.stringify([schema, name]), { schema, name })
    for (const child of node.Plans ?? []) visit(child)
  }
  visit(explain.Plan)
  return [...tables.values()]
}

function parseNode(node: JsonPlanNode): PlanNode {
  const details: PlanNode['details'] = []
  for (const field of DETAIL_FIELDS) {
    const value = node[field]
    if (value === undefined || (value === 0 && HIDDEN_WHEN_ZERO.has(field))) continue
    details.push({ label: field, value: Array.isArray(value) ? value.join(', ') : String(value) })
  }
  return {
    title: nodeTitle(node),
    nodeType: node['Node Type'],
    estimatedRows: node['Plan Rows'],
    actualRows: node['Actual Rows'],
    loops: node['Actual Loops'],
    sharedHit: node['Shared Hit Blocks'],
    sharedRead: node['Shared Read Blocks'],
    totalTimeMs: node['Actual Total Time'],
    details,
    children: (node.Plans ?? []).map(parseNode),
  }
}

const AGGREGATE_NAMES: Record<string, string> = {
  Plain: 'Aggregate',
  Sorted: 'GroupAggregate',
  Hashed: 'HashAggregate',
  Mixed: 'MixedAggregate',
}

/**
 * The node's heading as Postgres's text EXPLAIN (without VERBOSE) prints it,
 * following ExplainNode in explain.c: "Parallel Seq Scan on orders",
 * "Index Scan Backward using orders_pkey on orders o", "HashAggregate",
 * "Hash Left Join".
 */
function nodeTitle(node: JsonPlanNode) {
  let name = node['Node Type']
  if (name === 'Aggregate') name = AGGREGATE_NAMES[node['Strategy'] as string] ?? name

  const joinType = node['Join Type'] as string | undefined
  if (joinType !== undefined && joinType !== 'Inner') {
    // "Hash Join" becomes "Hash Left Join"; "Nested Loop" becomes "Nested Loop Left Join".
    name = `${name.replace(/ Join$/, '')} ${joinType} Join`
  }

  const partialMode = node['Partial Mode'] as string | undefined
  if (partialMode !== undefined && partialMode !== 'Simple') name = `${partialMode} ${name}`
  if (node['Parallel Aware'] === true) name = `Parallel ${name}`
  if (node['Scan Direction'] === 'Backward') name += ' Backward'

  const indexName = node['Index Name'] as string | undefined
  const relation = node['Relation Name'] as string | undefined
  const alias = node['Alias'] as string | undefined
  if (indexName !== undefined) name += node['Node Type'] === 'Bitmap Index Scan' ? ` on ${indexName}` : ` using ${indexName}`
  if (relation !== undefined) {
    name += ` on ${relation}`
    if (alias !== undefined && alias !== relation) name += ` ${alias}`
  }
  return name
}
