import { describe, expect, it } from 'vitest'
import type { DatabaseInfo, TableInfo } from '../db/catalog'
import { buildTree, findNode, findParent, initiallyExpanded, visibleNodes } from './tree'

const orders: TableInfo = {
  schema: 'public',
  name: 'orders',
  estimatedRows: 50_000,
  pages: 589,
  sizeBytes: 589 * 8192,
  columns: [
    { name: 'id', type: 'integer', notNull: true, primaryKey: true },
    { name: 'status', type: 'text', notNull: true, primaryKey: false },
  ],
  indexes: [
    { name: 'orders_pkey', definition: '', unique: true, primaryKey: true, levels: 2, pages: 139 },
  ],
  autovacuum: null,
}

const database: DatabaseInfo = {
  name: 'postgres',
  schemas: [
    { name: 'empty_one', tables: [] },
    { name: 'public', tables: [orders] },
  ],
}

describe('buildTree', () => {
  const root = buildTree(database)

  it('nests database → schemas → Tables → table → Columns and Indexes', () => {
    expect(root).toMatchObject({ label: 'postgres', kind: 'database' })
    expect(root.children.map((node) => node.label)).toEqual(['empty_one', 'public'])
    const publicSchema = root.children[1]
    expect(publicSchema.children.map((node) => [node.label, node.hint])).toEqual([['Tables', '1']])
    const table = publicSchema.children[0].children[0]
    expect(table).toMatchObject({ id: 'postgres/public/Tables/orders', kind: 'table' })
    expect(table.children.map((node) => [node.label, node.hint])).toEqual([
      ['Columns', '2'],
      ['Indexes', '1'],
    ])
    expect(table.children[0].children.map((node) => [node.label, node.hint])).toEqual([
      ['id', 'integer'],
      ['status', 'text'],
    ])
  })

  it('links each node to its catalog object, and folders to none', () => {
    const index = findNode(root, 'postgres/public/Tables/orders/Indexes/orders_pkey')
    expect(index?.object).toEqual({ kind: 'index', table: orders, index: orders.indexes[0] })
    expect(findNode(root, 'postgres/public/Tables')?.object).toBeNull()
  })

  it('shows an empty schema with an empty Tables folder', () => {
    expect(root.children[0].children[0]).toMatchObject({ label: 'Tables', hint: '0', children: [] })
  })
})

describe('visibleNodes', () => {
  const root = buildTree(database)

  it('starts with the database, schemas and Tables folders open', () => {
    const labels = visibleNodes(root, initiallyExpanded(root)).map((node) => node.label)
    expect(labels).toEqual(['postgres', 'empty_one', 'Tables', 'public', 'Tables', 'orders'])
  })

  it('hides the children of a collapsed node, even when the children were expanded', () => {
    const expanded = new Set([
      'postgres',
      'postgres/public',
      'postgres/public/Tables',
      'postgres/public/Tables/orders',
      'postgres/public/Tables/orders/Columns',
    ])
    const open = visibleNodes(root, expanded).map((node) => node.label)
    expect(open).toEqual(['postgres', 'empty_one', 'public', 'Tables', 'orders', 'Columns', 'id', 'status', 'Indexes'])

    expanded.delete('postgres/public/Tables/orders')
    const closed = visibleNodes(root, expanded).map((node) => node.label)
    expect(closed).toEqual(['postgres', 'empty_one', 'public', 'Tables', 'orders'])
  })
})

describe('findParent', () => {
  const root = buildTree(database)

  it('finds the parent of a node, and none for the root', () => {
    expect(findParent(root, 'postgres/public/Tables/orders/Columns/id')?.label).toBe('Columns')
    expect(findParent(root, 'postgres/public')?.label).toBe('postgres')
    expect(findParent(root, 'postgres')).toBeNull()
  })
})
