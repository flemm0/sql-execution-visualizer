import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { DatabaseInfo, TableInfo } from '../db/catalog'
import { columnCompletionSource, columnsInScope } from './columnCompletion'

function table(name: string, columns: string[]): TableInfo {
  return {
    schema: 'public',
    name,
    estimatedRows: 0,
    pages: 0,
    sizeBytes: 0,
    columns: columns.map((column) => ({ name: column, type: 'integer', notNull: false, primaryKey: false })),
    indexes: [],
    autovacuum: null,
  }
}

const database: DatabaseInfo = {
  name: 'postgres',
  schemas: [
    {
      name: 'public',
      tables: [
        table('orders', ['id', 'customer_id', 'status']),
        table('customers', ['id', 'email']),
        table('products', ['id', 'name']),
        table('odd', ['MixedCase']),
      ],
    },
  ],
}

describe('columnsInScope', () => {
  it('lists the columns of the tables a statement names, once each, sorted', () => {
    const words = ['SELECT', 'FROM', 'ORDERS', 'O', 'JOIN', 'PUBLIC', 'CUSTOMERS', 'C', 'ON', 'C', 'ID', 'O', 'CUSTOMER_ID']
    expect(columnsInScope(database, words)).toEqual([
      { name: 'customer_id', tables: ['orders'] },
      { name: 'email', tables: ['customers'] },
      { name: 'id', tables: ['orders', 'customers'] },
      { name: 'status', tables: ['orders'] },
    ])
  })

  it('lists nothing when no table is named, or before the catalog has loaded', () => {
    expect(columnsInScope(database, ['SELECT', 'ST'])).toEqual([])
    expect(columnsInScope(null, ['SELECT', 'FROM', 'ORDERS'])).toEqual([])
  })
})

/** Runs the source as if completion were triggered with the cursor at "|" in `text`. */
function complete(text: string, explicit = false): CompletionResult | null {
  const pos = text.indexOf('|')
  const doc = text.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: PostgreSQL })] })
  return columnCompletionSource(database)(new CompletionContext(state, pos, explicit)) as CompletionResult | null
}

function labels(result: CompletionResult | null) {
  return result?.options.map((option) => option.label) ?? null
}

describe('columnCompletionSource', () => {
  it('offers the columns of the tables in the statement under the cursor, above keywords', () => {
    const result = complete('SELECT 1 FROM products;\nSELECT * FROM orders WHERE stat|')
    expect(labels(result)).toEqual(['customer_id', 'id', 'status'])
    expect(result?.from).toBe('SELECT 1 FROM products;\nSELECT * FROM orders WHERE '.length)
    expect(result?.options[0].boost).toBeGreaterThan(0)
    expect(result?.options[1].detail).toBe('orders')
  })

  it('works for a column typed before the FROM that names its table', () => {
    expect(labels(complete('SELECT st| FROM orders'))).toEqual(['customer_id', 'id', 'status'])
  })

  it('quotes a name Postgres would otherwise fold to lower case', () => {
    const result = complete('SELECT M| FROM odd')
    expect(result?.options[0]).toMatchObject({ label: 'MixedCase', apply: '"MixedCase"' })
  })

  it('needs a typed letter, unless completion was asked for with Ctrl+Space', () => {
    expect(complete('SELECT * FROM orders WHERE |')).toBeNull()
    expect(labels(complete('SELECT * FROM orders WHERE |', true))).toEqual(['customer_id', 'id', 'status'])
  })

  it('leaves table.column, strings and comments alone', () => {
    expect(complete('SELECT * FROM orders o WHERE o.st|')).toBeNull()
    expect(complete("SELECT * FROM orders WHERE status = 'sh|")).toBeNull()
    expect(complete('SELECT * FROM orders -- st|')).toBeNull()
  })
})
