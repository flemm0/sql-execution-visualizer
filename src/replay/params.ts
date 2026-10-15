import type { PlanNode } from '../db/plan'

/*
 * Parameters: the inner side of a Nested Loop runs once per outer row, and
 * its conditions can use that row's values. EXPLAIN writes them as the outer
 * table's columns, e.g. the Index Cond "(o.customer_id = c.id)", where c is
 * the outer side's table. For each loop, the replay asks Postgres for the
 * outer row's values (rowValues.ts) and puts them into the conditions as
 * constants, "(o.customer_id = ('4242'::integer))", so the inner scan's
 * replay can treat them as it treats any other constant condition.
 */

/**
 * A name as Postgres writes it in a deparsed expression: plain (letters,
 * digits, _ and $, not starting with a digit) or in double quotes.
 */
const NAME = String.raw`(?:"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*)`
/** A qualified name at the start of the text, e.g. c.id or "Order"."Total". */
const QUALIFIED = new RegExp(`^(${NAME})\\.(${NAME})`, 'u')
/** A character that can be part of a plain name, or join two parts of a qualified one. */
const NAME_CHAR = /[\p{L}\p{N}_$."]/u

function unquote(name: string) {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name
}

/**
 * The places in an expression where a column of one of `aliases` is named,
 * e.g. "c.id" in "(o.customer_id = c.id)": each its text and where it starts.
 * String literals are skipped.
 */
function references(expression: string, aliases: Set<string>): { text: string; at: number }[] {
  const found: { text: string; at: number }[] = []
  let i = 0
  while (i < expression.length) {
    const char = expression[i]
    if (char === "'") {
      // A string literal; a doubled quote inside it closes and reopens.
      const end = expression.indexOf("'", i + 1)
      i = end === -1 ? expression.length : end + 1
      continue
    }
    const startsName = i === 0 || !NAME_CHAR.test(expression[i - 1])
    const match = startsName ? QUALIFIED.exec(expression.slice(i)) : null
    if (match === null) {
      i++
      continue
    }
    if (aliases.has(unquote(match[1]))) found.push({ text: match[0], at: i })
    i += match[0].length
  }
  return found
}

/**
 * The columns of the tables called `aliases` that an expression names, each
 * once, in the order first named, e.g. ["c.id"]; none for null.
 */
export function outerReferences(expression: string | null, aliases: Set<string>): string[] {
  if (expression === null) return []
  return [...new Set(references(expression, aliases).map((reference) => reference.text))]
}

/**
 * The expression with each column of `values` (by its text, e.g. "c.id")
 * replaced by its value, a SQL constant, e.g. "'4242'::integer". Null stays null.
 */
export function bindReferences(expression: string | null, values: Map<string, string>): string | null {
  if (expression === null) return null
  const aliases = new Set([...values.keys()].map((text) => unquote((QUALIFIED.exec(text) as RegExpExecArray)[1])))
  let out = ''
  let from = 0
  for (const { text, at } of references(expression, aliases)) {
    const value = values.get(text)
    if (value === undefined) continue
    out += `${expression.slice(from, at)}(${value})`
    from = at + text.length
  }
  return out + expression.slice(from)
}

/** The conditions of a node, and of the nodes under it, that can name an outer row's columns. */
function conditions(node: PlanNode): (string | null)[] {
  return [node.indexCond, node.filter, ...node.children.flatMap(conditions)]
}

/** The columns of the tables called `aliases` that a node or the nodes under it use, each once. */
export function subtreeReferences(node: PlanNode, aliases: Set<string>): string[] {
  return [...new Set(conditions(node).flatMap((condition) => outerReferences(condition, aliases)))]
}

/** A node, and the nodes under it, with these columns' values in their conditions (see bindReferences). */
export function bindNode(node: PlanNode, values: Map<string, string>): PlanNode {
  return {
    ...node,
    indexCond: bindReferences(node.indexCond, values),
    filter: bindReferences(node.filter, values),
    children: node.children.map((child) => bindNode(child, values)),
  }
}

/**
 * SQL that has Postgres write a column's value as a constant of its type,
 * e.g. "'4242'::integer" or "NULL::text", to put into a condition.
 */
export function constantOf(reference: string): string {
  return `quote_nullable(${reference}) || '::' || pg_typeof(${reference})::text`
}
