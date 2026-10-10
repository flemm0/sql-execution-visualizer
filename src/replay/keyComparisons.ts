import type { PGliteInterface } from '@electric-sql/pglite'
import type { IndexColumn } from '../db/inspector'
import { query } from '../db/query'
import { quoteLiteral } from '../db/sql'

/*
 * Asks Postgres how an index scan's key values compare, and remembers the
 * answers. The replay of a B-tree scan (btreeScan.ts) compares values all the
 * time, one at a time, as nbtree does; asking Postgres one comparison at a
 * time would take thousands of queries. Instead, each time the scan reads a
 * page, one query answers every comparison the page can need:
 *
 * - how the page's values rank among each other, and among the values the
 *   scan's arrays are at (all of the column's own type), in each column;
 * - how each of those values compares with each condition's value, which can
 *   be of another type (an int4 column compared with an int8, a timestamp with
 *   a date): Postgres's cross-type operators decide;
 * - where each value falls in each = ANY list;
 * - for a skip scan over a column whose type can count up (integers, dates,
 *   timestamps, booleans), the next value after each one.
 *
 * A comparison asked for later that no query answered yet runs one more.
 *
 * Values are SQL expressions: a value stored in the index, as indexKeys.ts
 * decodes it, the next value after one (`next`), or a condition's value as
 * the plan writes it. Every comparison uses the column's collation, as the
 * index does.
 */

/**
 * The types whose B-tree operator class can count up and down ("skip
 * support", Postgres 18): a skip scan over such a column moves from a value
 * straight to the next one. Other types (text) look the next value up in the
 * index instead. As listed in pg_amproc (support function 6), for the types
 * indexKeys.ts can read.
 */
const STEPS: Record<string, { next: (value: string) => string; previous: (value: string) => string }> = {
  bool: {
    next: (v) => `CASE WHEN NOT ${v} THEN true END`,
    previous: (v) => `CASE WHEN ${v} THEN false END`,
  },
  int2: {
    next: (v) => `CASE WHEN ${v} < 32767 THEN ${v} + 1 END`,
    previous: (v) => `CASE WHEN ${v} > -32768 THEN ${v} - 1 END`,
  },
  int4: {
    next: (v) => `CASE WHEN ${v} < 2147483647 THEN ${v} + 1 END`,
    previous: (v) => `CASE WHEN ${v} > -2147483648 THEN ${v} - 1 END`,
  },
  int8: {
    next: (v) => `CASE WHEN ${v} < 9223372036854775807 THEN ${v} + 1 END`,
    previous: (v) => `CASE WHEN ${v} > -9223372036854775808 THEN ${v} - 1 END`,
  },
  oid: {
    next: (v) => `CASE WHEN ${v} < 4294967295 THEN (${v}::int8 + 1)::oid END`,
    previous: (v) => `CASE WHEN ${v} > 0 THEN (${v}::int8 - 1)::oid END`,
  },
  date: {
    next: (v) => `CASE WHEN ${v} < 'infinity'::date THEN ${v} + 1 END`,
    previous: (v) => `CASE WHEN ${v} > '-infinity'::date THEN ${v} - 1 END`,
  },
  timestamp: {
    next: (v) => `CASE WHEN ${v} < 'infinity'::timestamp THEN ${v} + interval '1 microsecond' END`,
    previous: (v) => `CASE WHEN ${v} > '-infinity'::timestamp THEN ${v} - interval '1 microsecond' END`,
  },
  timestamptz: {
    next: (v) => `CASE WHEN ${v} < 'infinity'::timestamptz THEN ${v} + interval '1 microsecond' END`,
    previous: (v) => `CASE WHEN ${v} > '-infinity'::timestamptz THEN ${v} - interval '1 microsecond' END`,
  },
}

/** Whether a skip scan over a column of this type steps from one value straight to the next (skip support). */
export function canStep(type: string): boolean {
  return type in STEPS
}

/** The value after `value` in a column of this type, as SQL: NULL after the last one. */
export function nextValue(type: string, value: string): string {
  return `CAST((${STEPS[type].next(`CAST(${value} AS ${type})`)}) AS ${type})`
}

/** The value before `value`, as SQL: NULL before the first one. */
export function previousValue(type: string, value: string): string {
  return `CAST((${STEPS[type].previous(`CAST(${value} AS ${type})`)}) AS ${type})`
}

/** Where a value falls in an = ANY list (sorted, without duplicates). */
interface ListPosition {
  /** How many of the list's values are lower. */
  lower: number
  /** Whether the next one is equal to it. */
  equal: boolean
}

/** What one column needs answered. */
interface ColumnNeeds {
  /** Values of the column's type. */
  values: string[]
  /** Values to compare them with: the conditions' values on this column. */
  constants: string[]
  /** The column's = ANY lists, each sorted, without duplicates. */
  lists: string[][]
}

export class KeyComparisons {
  /** For each column, groups of values ranked together by one query: 1 for the lowest. */
  private ranks: Map<string, number>[][]
  /** For each column, a value's text (null for a next value past the last). */
  private texts: Map<string, string | null>[]
  /** For each column, value and constant → sign. */
  private signs: Map<string, number>[]
  /** For each column, value and list → position. */
  private positions: Map<string, ListPosition>[]
  /** For each column, value → the next value, null after the last one (only for columns that step). */
  private nexts: Map<string, string | null>[]

  /**
   * `constants` and `lists` are each column's conditions' values and = ANY
   * lists; `stepping` the columns a skip scan steps through.
   */
  private db: PGliteInterface
  private columns: IndexColumn[]
  private constants: string[][]
  private lists: string[][][]
  private stepping: boolean[]

  constructor(db: PGliteInterface, columns: IndexColumn[], constants: string[][], lists: string[][][], stepping: boolean[]) {
    this.db = db
    this.columns = columns
    this.constants = constants
    this.lists = lists
    this.stepping = stepping
    this.ranks = columns.map(() => [])
    this.texts = columns.map(() => new Map())
    this.signs = columns.map(() => new Map())
    this.positions = columns.map(() => new Map())
    this.nexts = columns.map(() => new Map())
  }

  /**
   * Answers, in one query, every comparison among these values (by column),
   * and between them and the conditions' values, unless an earlier query did.
   */
  async prepare(values: (string | null)[][]): Promise<void> {
    const needs: ColumnNeeds[] = this.columns.map((_, column) => {
      const own = unique((values[column] ?? []).filter((value): value is string => value !== null))
      const known = this.ranks[column].some((group) => own.every((value) => group.has(value)))
      if (own.length === 0 || known) return { values: [], constants: [], lists: [] }
      const withNext = this.stepping[column]
        ? unique([...own, ...own.map((value) => nextValue(this.columns[column].type, value))])
        : own
      return { values: withNext, constants: this.constants[column], lists: this.lists[column] }
    })
    await this.ask(needs)
  }

  /** How two values of a column compare: -1, 0 or 1. */
  async compare(column: number, a: string, b: string): Promise<number> {
    let group = [...this.ranks[column]].reverse().find((each) => each.has(a) && each.has(b))
    if (group === undefined) {
      await this.ask(this.only(column, { values: [a, b], constants: [], lists: [] }))
      group = this.ranks[column].at(-1) as Map<string, number>
    }
    return Math.sign((group.get(a) as number) - (group.get(b) as number))
  }

  /** How a value of a column compares with one of the conditions' values on it: -1, 0 or 1. */
  async compareWithConstant(column: number, value: string, constant: string): Promise<number> {
    const key = pair(value, constant)
    if (!this.signs[column].has(key)) {
      await this.ask(this.only(column, { values: [value], constants: [constant], lists: [] }))
    }
    return this.signs[column].get(key) as number
  }

  /** How a value compares with the element at `position` of an = ANY list on its column: -1, 0 or 1. */
  async compareWithElement(column: number, value: string, list: string[], position: number): Promise<number> {
    const key = pair(value, list.join(','))
    if (!this.positions[column].has(key)) {
      await this.ask(this.only(column, { values: [value], constants: [], lists: [list] }))
    }
    const found = this.positions[column].get(key) as ListPosition
    if (position < found.lower) return 1
    return position === found.lower && found.equal ? 0 : -1
  }

  /** The value after this one in its column (skip support), or null if it's the last. */
  async next(column: number, value: string): Promise<string | null> {
    if (!this.nexts[column].has(value)) await this.ask(this.only(column, { values: [value], constants: [], lists: [] }))
    return this.nexts[column].get(value) as string | null
  }

  /** A value as Postgres writes it. Only for values a query has seen. */
  text(column: number, value: string | null): string | null {
    if (value === null) return null
    const text = this.texts[column].get(value)
    if (text === undefined) throw new Error(`No text for ${value}`)
    return text
  }

  private only(column: number, needs: ColumnNeeds): ColumnNeeds[] {
    const withNext = this.stepping[column]
      ? { ...needs, values: unique([...needs.values, ...needs.values.map((v) => nextValue(this.columns[column].type, v))]) }
      : needs
    return this.columns.map((_, i) => (i === column ? withNext : { values: [], constants: [], lists: [] }))
  }

  /** Runs one query for everything `needs` asks, and remembers the answers. */
  private async ask(needs: ColumnNeeds[]): Promise<void> {
    const ctes: string[] = []
    const selects: string[] = []
    needs.forEach(({ values, constants, lists }, column) => {
      if (values.length === 0) return
      const { type, collation } = this.columns[column]
      const name = `values_${column}`
      const v = collation === null ? 'v' : `v COLLATE ${collation}`
      ctes.push(`${name}(i, v) AS (VALUES ${values.map((value, i) => `(${i}, CAST(${value} AS ${type}))`).join(', ')})`)
      selects.push(`SELECT 'rank', ${column}, i, -1, dense_rank() OVER (ORDER BY ${v}), v::text FROM ${name}`)
      constants.forEach((constant, k) => {
        selects.push(`SELECT 'sign', ${column}, i, ${k},
          CASE WHEN ${v} < ${constant} THEN -1 WHEN ${v} = ${constant} THEN 0 ELSE 1 END, NULL
          FROM ${name} WHERE v IS NOT NULL`)
      })
      lists.forEach((list, l) => {
        const elements = `(VALUES ${list.map((element) => `(${element})`).join(', ')}) AS list(e)`
        selects.push(`SELECT 'list', ${column}, i, ${l},
          (SELECT count(*) FROM ${elements} WHERE ${v} > e), (SELECT bool_or(${v} = e) FROM ${elements})::text
          FROM ${name} WHERE v IS NOT NULL`)
      })
    })
    if (selects.length === 0) return

    const result = await query<{ what: string; column: number; i: number; k: number; n: number; text: string | null }>(
      this.db,
      `WITH ${ctes.join(',\n')}
       SELECT what, "column", i, k, n::int8, text FROM (
         ${selects.join('\nUNION ALL\n')}
       ) AS answers(what, "column", i, k, n, text)`,
    )
    const groups = new Map<number, Map<string, number>>()
    for (const row of result.rows) {
      const column = Number(row.column)
      const { values, constants, lists } = needs[column]
      const value = values[row.i]
      const n = Number(row.n)
      if (row.what === 'rank') {
        if (!groups.has(column)) groups.set(column, new Map())
        // A next value past the last one is NULL: it has no rank.
        if (row.text !== null) groups.get(column)?.set(value, n)
        this.texts[column].set(value, row.text)
      } else if (row.what === 'sign') {
        this.signs[column].set(pair(value, constants[row.k]), n)
      } else {
        this.positions[column].set(pair(value, lists[row.k].join(',')), { lower: n, equal: row.text === 'true' })
      }
    }
    for (const [column, group] of groups) {
      this.ranks[column].push(group)
      if (!this.stepping[column]) continue
      const type = this.columns[column].type
      const asked = needs[column].values
      const nexts = new Set(asked.map((value) => nextValue(type, value)))
      // Each value by rank, preferring one that isn't a next value.
      const byRank = new Map<number, string>()
      for (const value of asked) {
        const rank = group.get(value)
        if (rank !== undefined && (!byRank.has(rank) || !nexts.has(value))) byRank.set(rank, value)
      }
      for (const value of asked) {
        const next = nextValue(type, value)
        if (!group.has(next) && this.texts[column].get(next) !== null) continue
        const text = this.texts[column].get(next) as string | null
        if (text === null) {
          this.nexts[column].set(value, null)
          continue
        }
        // Known from now on as an equal value from the index, or by its text;
        // not as "the next value after the next value after ...": that
        // expression would double in size with each step, and nothing would
        // be known about it.
        const equal = byRank.get(group.get(next) as number) as string
        if (!nexts.has(equal)) {
          this.nexts[column].set(value, equal)
          continue
        }
        const literal = `CAST(${quoteLiteral(text)} AS ${type})`
        this.nexts[column].set(value, literal)
        this.alias(column, next, literal, group)
      }
    }
  }

  /** Remembers everything known about one expression for another with the same value. */
  private alias(column: number, from: string, to: string, group: Map<string, number>) {
    group.set(to, group.get(from) as number)
    this.texts[column].set(to, this.texts[column].get(from) as string)
    for (const constant of this.constants[column]) {
      const sign = this.signs[column].get(pair(from, constant))
      if (sign !== undefined) this.signs[column].set(pair(to, constant), sign)
    }
    for (const list of this.lists[column]) {
      const position = this.positions[column].get(pair(from, list.join(',')))
      if (position !== undefined) this.positions[column].set(pair(to, list.join(',')), position)
    }
  }
}

function pair(a: string, b: string) {
  return `${a}\u0000${b}`
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}
