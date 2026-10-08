import type { ColumnInfo, DatabaseInfo, IndexInfo, SchemaInfo, TableInfo } from '../db/catalog'

/**
 * The catalog object a tree node stands for, shown in the details panel when
 * the node is selected. Folder nodes ("Tables", "Columns", "Indexes") have none.
 * Each variant has a `kind` field, so code can check `object.kind === 'table'`
 * and TypeScript then knows `object.table` exists.
 */
export type CatalogObject =
  | { kind: 'database'; database: DatabaseInfo }
  | { kind: 'schema'; schema: SchemaInfo }
  | { kind: 'table'; table: TableInfo }
  | { kind: 'column'; table: TableInfo; column: ColumnInfo }
  | { kind: 'index'; table: TableInfo; index: IndexInfo }

export type NodeKind = CatalogObject['kind'] | 'folder'

export interface TreeNode {
  /** Unique within the tree: the path of labels from the root, e.g. "postgres/public/Tables/orders". */
  id: string
  label: string
  kind: NodeKind
  /** Short text shown after the label, e.g. a column's type or a folder's item count. */
  hint?: string
  object: CatalogObject | null
  children: TreeNode[]
}

/** Database → schemas → Tables → each table → Columns and Indexes. */
export function buildTree(database: DatabaseInfo): TreeNode {
  const root = database.name
  return {
    id: root,
    label: database.name,
    kind: 'database',
    object: { kind: 'database', database },
    children: database.schemas.map((schema) => schemaNode(root, schema)),
  }
}

function schemaNode(parentId: string, schema: SchemaInfo): TreeNode {
  const id = `${parentId}/${schema.name}`
  const tablesId = `${id}/Tables`
  return {
    id,
    label: schema.name,
    kind: 'schema',
    object: { kind: 'schema', schema },
    children: [folder(tablesId, 'Tables', schema.tables.map((table) => tableNode(tablesId, table)))],
  }
}

function tableNode(parentId: string, table: TableInfo): TreeNode {
  const id = `${parentId}/${table.name}`
  const columns = table.columns.map(
    (column): TreeNode => ({
      id: `${id}/Columns/${column.name}`,
      label: column.name,
      kind: 'column',
      hint: column.type,
      object: { kind: 'column', table, column },
      children: [],
    }),
  )
  const indexes = table.indexes.map(
    (index): TreeNode => ({
      id: `${id}/Indexes/${index.name}`,
      label: index.name,
      kind: 'index',
      object: { kind: 'index', table, index },
      children: [],
    }),
  )
  return {
    id,
    label: table.name,
    kind: 'table',
    object: { kind: 'table', table },
    children: [folder(`${id}/Columns`, 'Columns', columns), folder(`${id}/Indexes`, 'Indexes', indexes)],
  }
}

function folder(id: string, label: string, children: TreeNode[]): TreeNode {
  return { id, label, kind: 'folder', hint: String(children.length), object: null, children }
}

/** The nodes a reader can see, top to bottom: the root, plus the children of every expanded node whose parents are expanded too. */
export function visibleNodes(root: TreeNode, expanded: ReadonlySet<string>): TreeNode[] {
  const visible: TreeNode[] = []
  function visit(node: TreeNode) {
    visible.push(node)
    if (expanded.has(node.id)) node.children.forEach(visit)
  }
  visit(root)
  return visible
}

/** The parent of the node with this id, or null for the root (or an unknown id). */
export function findParent(root: TreeNode, id: string): TreeNode | null {
  for (const child of root.children) {
    if (child.id === id) return root
    const found = findParent(child, id)
    if (found) return found
  }
  return null
}

export function findNode(root: TreeNode, id: string): TreeNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findNode(child, id)
    if (found) return found
  }
  return null
}

/** Open on first view: the database, each schema, and each schema's Tables folder. */
export function initiallyExpanded(root: TreeNode): Set<string> {
  const ids = new Set([root.id])
  for (const schema of root.children) {
    ids.add(schema.id)
    for (const folderNode of schema.children) ids.add(folderNode.id)
  }
  return ids
}
