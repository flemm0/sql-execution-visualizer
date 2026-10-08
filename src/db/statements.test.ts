import { describe, expect, it } from 'vitest'
import { commandName, isQuery, splitStatements, statementAt } from './statements'

function texts(sql: string) {
  return splitStatements(sql).map((statement) => statement.text)
}

describe('splitStatements', () => {
  it('splits at semicolons and trims each statement', () => {
    expect(texts('SELECT 1;\n\n  SELECT 2 ;SELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('reports where each statement sits in the text', () => {
    const sql = 'SELECT 1;\n  SELECT 2;'
    const [first, second] = splitStatements(sql)
    expect([first.from, first.to]).toEqual([0, 8])
    expect([second.from, second.to]).toEqual([12, 20])
    expect(sql.slice(second.from, second.to)).toBe('SELECT 2')
  })

  it('ignores semicolons inside strings, quoted identifiers, dollar quotes and comments', () => {
    const sql = `
      SELECT 'a;b', 'it''s; fine', E'back\\'slash;';
      SELECT "odd;name" FROM t;
      CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;
      DO $body$ BEGIN PERFORM 1; END $body$;
      SELECT 1 -- trailing; comment
      ;
      /* block; /* nested; */ still comment; */ SELECT 2;
    `
    expect(texts(sql)).toEqual([
      `SELECT 'a;b', 'it''s; fine', E'back\\'slash;'`,
      'SELECT "odd;name" FROM t',
      'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql',
      'DO $body$ BEGIN PERFORM 1; END $body$',
      'SELECT 1 -- trailing; comment',
      '/* block; /* nested; */ still comment; */ SELECT 2',
    ])
  })

  it('drops empty statements and statements made only of comments', () => {
    expect(texts(';; -- just a note\n; /* and this */ ;  ')).toEqual([])
  })

  it('collects the words outside strings and comments, upper-cased', () => {
    const [statement] = splitStatements(`select "Insert", 'delete' from orders -- update\nwhere id = 1`)
    expect(statement.words).toEqual(['SELECT', 'FROM', 'ORDERS', 'WHERE', 'ID'])
  })

  it('treats $1 as a parameter, not a dollar quote', () => {
    expect(texts('SELECT $1; SELECT 2')).toEqual(['SELECT $1', 'SELECT 2'])
  })
})

describe('statementAt', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\nSELECT 3'
  const statements = splitStatements(sql)

  it('picks the statement the cursor is in', () => {
    expect(statementAt(statements, sql.indexOf('2'))?.text).toBe('SELECT 2')
  })

  it('picks the statement before the cursor when the cursor is between statements', () => {
    expect(statementAt(statements, sql.indexOf(';') + 1)?.text).toBe('SELECT 1')
    expect(statementAt(statements, sql.indexOf('\n\n') + 1)?.text).toBe('SELECT 1')
  })

  it('picks the first statement when the cursor is before it, and null when there is none', () => {
    expect(statementAt(splitStatements('  SELECT 1'), 0)?.text).toBe('SELECT 1')
    expect(statementAt([], 0)).toBeNull()
  })
})

describe('isQuery', () => {
  function query(sql: string) {
    return isQuery(splitStatements(sql)[0])
  }

  it('accepts statements that only read', () => {
    expect(query('SELECT * FROM orders')).toBe(true)
    expect(query('with recent as (select 1) select * from recent')).toBe(true)
    expect(query('VALUES (1), (2)')).toBe(true)
    expect(query('TABLE categories')).toBe(true)
    expect(query('SELECT * FROM orders FOR UPDATE')).toBe(true)
    expect(query('SELECT * FROM orders FOR NO KEY UPDATE')).toBe(true)
    expect(query(`SELECT 'insert into' AS words`)).toBe(true)
  })

  it('rejects statements that write, even when they start with SELECT or WITH', () => {
    expect(query('INSERT INTO t VALUES (1)')).toBe(false)
    expect(query('CREATE INDEX ON orders (status)')).toBe(false)
    expect(query('EXPLAIN SELECT 1')).toBe(false)
    expect(query('SELECT * INTO copy FROM orders')).toBe(false)
    expect(query('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone')).toBe(false)
    expect(query('WITH changed AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM changed')).toBe(false)
  })
})

describe('commandName', () => {
  function name(sql: string) {
    return commandName(splitStatements(sql)[0])
  }

  it('names statements like psql command tags', () => {
    expect(name('select 1')).toBe('SELECT')
    expect(name('UPDATE orders SET status = 1')).toBe('UPDATE')
    expect(name('CREATE INDEX ON orders (status)')).toBe('CREATE INDEX')
    expect(name('create unique index i on t (a)')).toBe('CREATE INDEX')
    expect(name('CREATE OR REPLACE TEMP VIEW v AS SELECT 1')).toBe('CREATE VIEW')
    expect(name('CREATE MATERIALIZED VIEW m AS SELECT 1')).toBe('CREATE MATERIALIZED VIEW')
    expect(name('DROP TABLE IF EXISTS t')).toBe('DROP TABLE')
    expect(name('ALTER TABLE t ADD COLUMN c int')).toBe('ALTER TABLE')
  })
})
