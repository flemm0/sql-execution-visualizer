import { describe, expect, it } from 'vitest'
import { bindReferences, outerReferences } from './params'

describe('an inner scan’s parameters', () => {
  const outer = new Set(['c'])

  it('are the outer tables’ columns its conditions name, each once', () => {
    expect(outerReferences('(o.customer_id = c.id)', outer)).toEqual(['c.id'])
    expect(outerReferences('((o.total > (c.id)::numeric) AND (o.customer_id = c.id))', outer)).toEqual(['c.id'])
    expect(outerReferences('(lower(o.note) = lower(c.email))', outer)).toEqual(['c.email'])
    expect(outerReferences('("Order"."Total" > "C"."Limit")', new Set(['C']))).toEqual(['"C"."Limit"'])
    expect(outerReferences(null, outer)).toEqual([])
  })

  it('aren’t the inner table’s own columns, text inside a string, or the end of a longer name', () => {
    expect(outerReferences('(o.customer_id = 42)', outer)).toEqual([])
    expect(outerReferences(`(o.note = 'see c.id')`, outer)).toEqual([])
    expect(outerReferences('(o.customer_id = abc.id)', outer)).toEqual([])
    expect(outerReferences('(o.c.id = 1)', outer)).toEqual([])
  })

  it('are replaced by the outer row’s values, as constants', () => {
    const values = new Map([['c.id', `'4242'::integer`]])
    expect(bindReferences('(o.customer_id = c.id)', values)).toBe(`(o.customer_id = ('4242'::integer))`)
    expect(bindReferences('(o.total > (c.id)::numeric)', values)).toBe(`(o.total > (('4242'::integer))::numeric)`)
    expect(bindReferences(`(o.note = 'c.id')`, values)).toBe(`(o.note = 'c.id')`)
    expect(bindReferences(null, values)).toBe(null)
    expect(bindReferences('(o.customer_id = c.id)', new Map())).toBe('(o.customer_id = c.id)')
  })
})
