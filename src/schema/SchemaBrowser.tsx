import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DatabaseInfo } from '../db/catalog'
import { DetailsPanel } from './DetailsPanel'
import { NodeIcon } from './icons'
import { buildTree, findNode, findParent, initiallyExpanded, visibleNodes, type TreeNode } from './tree'

/**
 * The schema browser: a tree of database → schemas → tables → columns and
 * indexes, like the object explorer in pgAdmin or Snowflake, with the selected
 * object's details underneath.
 *
 * Keyboard (the WAI-ARIA tree pattern): Up/Down move, Right opens or steps into
 * a node, Left closes it or steps out to the parent, Home/End jump, Enter or
 * Space selects (and opens or closes).
 */
interface SchemaBrowserProps {
  database: DatabaseInfo
  /** Whether the autovacuum simulator is turned on, for the table details. */
  autovacuumOn: boolean
}

export function SchemaBrowser({ database, autovacuumOn }: SchemaBrowserProps) {
  const root = useMemo(() => buildTree(database), [database])
  // Node ids are paths of names, so they stay valid when the catalog is reloaded.
  const [expanded, setExpanded] = useState<Set<string>>(() => initiallyExpanded(root))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState(root.id)
  // The rendered <li> for each visible node, so keyboard moves can focus it.
  const items = useRef(new Map<string, HTMLLIElement>())

  const visible = visibleNodes(root, expanded)
  // Exactly one item is reachable with Tab: the focused one, or the root if that one is hidden or gone.
  const tabStop = visible.some((node) => node.id === focusedId) ? focusedId : root.id
  const selected = selectedId === null ? null : findNode(root, selectedId)

  function setOpen(id: string, open: boolean) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function moveFocus(id: string) {
    setFocusedId(id)
    items.current.get(id)?.focus()
  }

  /** A click, Enter or Space: select the object (folders have none) and open or close the node. */
  function activate(node: TreeNode) {
    setFocusedId(node.id)
    if (node.object) setSelectedId(node.id)
    if (node.children.length > 0) setOpen(node.id, !expanded.has(node.id))
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const index = visible.findIndex((node) => node.id === tabStop)
    const node = visible[index]
    const isOpen = expanded.has(node.id)
    switch (event.key) {
      case 'ArrowDown':
        moveFocus(visible[Math.min(index + 1, visible.length - 1)].id)
        break
      case 'ArrowUp':
        moveFocus(visible[Math.max(index - 1, 0)].id)
        break
      case 'Home':
        moveFocus(visible[0].id)
        break
      case 'End':
        moveFocus(visible[visible.length - 1].id)
        break
      case 'ArrowRight':
        if (node.children.length > 0) {
          if (isOpen) moveFocus(node.children[0].id)
          else setOpen(node.id, true)
        }
        break
      case 'ArrowLeft':
        if (isOpen && node.children.length > 0) {
          setOpen(node.id, false)
        } else {
          const parent = findParent(root, node.id)
          if (parent) moveFocus(parent.id)
        }
        break
      case 'Enter':
      case ' ':
        activate(node)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const tree: TreeContext = {
    expanded,
    selectedId,
    tabStop,
    activate,
    registerItem(id, element) {
      items.current.set(id, element)
      return () => items.current.delete(id)
    },
  }

  return (
    <div className="flex h-full flex-col">
      <ul role="tree" aria-label="Database objects" className="min-h-0 flex-1 overflow-auto py-1" onKeyDown={onKeyDown}>
        <TreeItem node={root} level={1} tree={tree} />
      </ul>
      <DetailsPanel object={selected?.object ?? null} autovacuumOn={autovacuumOn} />
    </div>
  )
}

/** What every row of the tree needs from SchemaBrowser. */
interface TreeContext {
  expanded: ReadonlySet<string>
  selectedId: string | null
  tabStop: string
  activate: (node: TreeNode) => void
  /** Records a row's element; returns a function that forgets it when the row goes away. */
  registerItem: (id: string, element: HTMLLIElement) => () => void
}

/** One row, plus its children when open. Renders itself again for each child. */
function TreeItem({ node, level, tree }: { node: TreeNode; level: number; tree: TreeContext }) {
  const hasChildren = node.children.length > 0
  const isOpen = hasChildren && tree.expanded.has(node.id)
  const isSelected = tree.selectedId === node.id

  return (
    <li
      role="treeitem"
      aria-label={node.label}
      aria-level={level}
      aria-expanded={hasChildren ? isOpen : undefined}
      aria-selected={isSelected}
      tabIndex={node.id === tree.tabStop ? 0 : -1}
      ref={(element) => (element ? tree.registerItem(node.id, element) : undefined)}
      className="outline-none [&:focus-visible>div]:ring-1 [&:focus-visible>div]:ring-index [&:focus-visible>div]:ring-inset"
    >
      <div
        className={`flex h-6 cursor-pointer items-center gap-1.5 pr-3 select-none ${
          isSelected ? 'bg-index/15 text-fg' : 'hover:bg-surface-2'
        }`}
        style={{ paddingLeft: 4 + (level - 1) * 14 }}
        onClick={() => tree.activate(node)}
      >
        <span className="grid size-3.5 shrink-0 place-items-center text-fg-muted">
          {hasChildren && (
            <svg
              viewBox="0 0 24 24"
              className={`size-3 ${isOpen ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          )}
        </span>
        <NodeIcon node={node} />
        <span className={`truncate ${node.kind === 'folder' ? 'text-fg-muted' : ''}`} title={node.label}>
          {node.label}
        </span>
        {node.hint && <span className="ml-auto shrink-0 pl-2 font-mono text-xs text-fg-muted">{node.hint}</span>}
      </div>
      {isOpen && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeItem key={child.id} node={child} level={level + 1} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  )
}
