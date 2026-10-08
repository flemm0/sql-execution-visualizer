import { PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorSelection, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { useEffect, useRef, type RefObject } from 'react'
import type { DatabaseInfo } from '../db/catalog'

export type RunMode = 'statement' | 'all'

interface SqlEditorProps {
  /** The text the editor starts with. Later changes to this prop are ignored. */
  initialText: string
  /** The catalog, for completing table and column names. */
  database: DatabaseInfo | null
  /** Called on Cmd/Ctrl+Enter (the statement under the cursor) and Shift+Cmd/Ctrl+Enter (everything). */
  onRun: (mode: RunMode) => void
  /** Called after every edit, with the whole text. */
  onChange: (text: string) => void
  /** Filled with the editor, so the toolbar's Run buttons can read the text and cursor. */
  viewRef: RefObject<EditorView | null>
}

/**
 * The SQL editor: CodeMirror 6 with Postgres syntax, and completion of
 * keywords, schemas, tables and columns from the live catalog.
 *
 * CodeMirror manages its own DOM and state, so React only gives it an empty
 * <div> to fill (in an effect) and tells it about new props through
 * `dispatch`. The editor is not re-created on re-render.
 */
export function SqlEditor({ initialText, database, onRun, onChange, viewRef }: SqlEditorProps) {
  const container = useRef<HTMLDivElement>(null)
  // The language settings can be swapped later (when the catalog changes) without rebuilding the editor.
  const language = useRef(new Compartment())
  // The latest callbacks, read by the editor's key bindings and update listener, which are set up once.
  const callbacks = useRef({ onRun, onChange })
  useEffect(() => {
    callbacks.current = { onRun, onChange }
  })

  useEffect(() => {
    const view = new EditorView({
      parent: container.current as HTMLDivElement,
      doc: initialText,
      extensions: [
        // Higher precedence than basicSetup's own Mod-Enter (insert a blank line).
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                callbacks.current.onRun('statement')
                return true // handled: no other binding runs
              },
            },
            {
              key: 'Shift-Mod-Enter',
              run: () => {
                callbacks.current.onRun('all')
                return true
              },
            },
          ]),
        ),
        // Line numbers, undo history, bracket matching, completion pop-ups and the usual key bindings.
        basicSetup,
        language.current.of(sqlLanguage(null)),
        syntaxHighlighting(highlightStyle),
        editorTheme,
        EditorView.contentAttributes.of({ 'aria-label': 'SQL editor' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
        }),
      ],
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Created once: initialText and viewRef are only read the first time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: language.current.reconfigure(sqlLanguage(database)) })
  }, [database, viewRef])

  return <div ref={container} className="h-full" data-testid="sql-editor" />
}

/** Moves the editor's cursor to an offset and selects up to `to`, scrolling it into view. */
export function selectInEditor(view: EditorView, from: number, to = from) {
  view.dispatch({ selection: EditorSelection.single(from, to), scrollIntoView: true })
  view.focus()
}

/**
 * Postgres syntax, plus the catalog as completions: "orders" completes
 * anywhere (public is the default schema), and "orders." completes its columns.
 */
function sqlLanguage(database: DatabaseInfo | null) {
  const schema: SQLNamespace = {}
  for (const namespace of database?.schemas ?? []) {
    const tables: Record<string, string[]> = {}
    for (const table of namespace.tables) tables[table.name] = table.columns.map((column) => column.name)
    schema[namespace.name] = tables
  }
  return sql({ dialect: PostgreSQL, schema, defaultSchema: 'public', upperCaseKeywords: true })
}

/*
 * Syntax colors stay neutral on purpose: the accent colors each mean one thing
 * (index, heap, result...; docs/UX.md#color-meanings), so code doesn't use them.
 */
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--text-primary)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--text-secondary)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--text-secondary)' },
  { tag: tags.comment, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--text-primary)', fontStyle: 'italic' },
])

/** Colors from the design tokens, so the editor follows the light and dark themes. */
const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface-page)', color: 'var(--text-primary)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--text-primary)' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-1)', color: 'var(--text-secondary)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--surface-1)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--border-strong) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--surface-2)', outline: '1px solid var(--border-strong)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-1)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--surface-2)', color: 'var(--text-primary)' },
  '.cm-completionDetail': { color: 'var(--text-secondary)' },
})
