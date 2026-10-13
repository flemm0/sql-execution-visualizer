import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DETAIL_FIELDS } from '../db/plan'
import { REPLAYABLE } from '../replay/replay'
import { GLOSSARY, isGlossaryTerm, nodeTypeTerm } from './glossary'

const SRC = join(import.meta.dirname, '..')

/** Every .tsx file under src/. */
function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return componentFiles(path)
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

/** The terms the source passes to <Term> by name: term="heap", term={'heap'}. */
function termsUsedInSource(): { file: string; term: string }[] {
  return componentFiles(SRC).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/<Term\s+term=(?:"([^"]+)"|\{'([^']+)'\})/g)].map((match) => ({
      file: file.slice(SRC.length + 1),
      term: match[1] ?? match[2],
    })),
  )
}

describe('the glossary', () => {
  it('defines every term the components mark', () => {
    const used = termsUsedInSource()
    // The scan finds the terms: the plan pane, the visualization, the page browser, the schema browser, the toolbar.
    expect(used.length).toBeGreaterThan(20)
    const missing = used.filter(({ term }) => !isGlossaryTerm(term))
    expect(missing).toEqual([])
  })

  it('defines every field the plan pane shows under a node', () => {
    expect(DETAIL_FIELDS.filter((field) => !isGlossaryTerm(field))).toEqual([])
  })

  it('defines every node type the replay animates, and Sort and Limit', () => {
    const nodeTypes = [...REPLAYABLE, 'Sort', 'Limit']
    expect(nodeTypes.filter((type) => !isGlossaryTerm(type))).toEqual([])
  })

  it('keeps each definition to one or two sentences', () => {
    for (const [term, definition] of Object.entries(GLOSSARY)) {
      const sentences = definition.split(/[.!?](?:\s|$)/).filter((part) => part.trim() !== '')
      expect(sentences.length, term).toBeGreaterThanOrEqual(1)
      expect(sentences.length, term).toBeLessThanOrEqual(2)
    }
  })
})

describe('nodeTypeTerm', () => {
  it('finds the node type at the start of a heading', () => {
    expect(nodeTypeTerm('Index Scan using orders_pkey on orders', 'Index Scan')).toBe('Index Scan')
    expect(nodeTypeTerm('Index Only Scan using orders_customer_id_order_date_idx on orders', 'Index Only Scan')).toBe(
      'Index Only Scan',
    )
    expect(nodeTypeTerm('Bitmap Index Scan on orders_customer_id_order_date_idx', 'Bitmap Index Scan')).toBe('Bitmap Index Scan')
    expect(nodeTypeTerm('Seq Scan on order_items', 'Seq Scan')).toBe('Seq Scan')
    expect(nodeTypeTerm('Limit', 'Limit')).toBe('Limit')
  })

  it('names an Aggregate node by its strategy, as the heading does', () => {
    expect(nodeTypeTerm('HashAggregate', 'Aggregate')).toBe('HashAggregate')
    expect(nodeTypeTerm('Aggregate', 'Aggregate')).toBe('Aggregate')
  })

  it('marks nothing when the heading renames the node, or the glossary has no term for it', () => {
    // A join type moves into the name; "Hash" alone would be the wrong term.
    expect(nodeTypeTerm('Hash Left Join', 'Hash Join')).toBeNull()
    expect(nodeTypeTerm('Index Scanner', 'Index Scan')).toBeNull()
    expect(nodeTypeTerm('Gather', 'Gather')).toBeNull()
  })
})
