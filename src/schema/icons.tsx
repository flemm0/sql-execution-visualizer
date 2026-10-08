import type { TreeNode } from './tree'

/**
 * The small icon before each tree row. Tables use the heap color and indexes
 * the index color, as everywhere else (docs/UX.md#color-meanings); the rest
 * stay neutral.
 */
export function NodeIcon({ node }: { node: TreeNode }) {
  const object = node.object
  if (object?.kind === 'column' && object.column.primaryKey) {
    return <Icon className="text-fg" path="M14 10a4 4 0 1 0-3.5 3.97L9 15.5V18h2.5v2H14v-3.5l1.03-1.03A4 4 0 0 0 14 10z" />
  }
  switch (node.kind) {
    case 'database':
      return (
        <Icon
          className="text-fg-muted"
          path="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"
        />
      )
    case 'schema':
      return <Icon className="text-fg-muted" path="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5" />
    case 'folder':
      return <Icon className="text-fg-muted" path="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    case 'table':
      return <Icon className="text-heap" path="M3 5h18v14H3zM3 10h18M3 15h18M9 10v9" />
    case 'column':
      return <Icon className="text-fg-muted" path="M8 4h8v16H8zM8 9h8" />
    case 'index':
      return <Icon className="text-index" path="M12 4v5M12 9l-6 5M12 9l6 5M6 14v5M18 14v5M10 4h4M4 19h4M16 19h4" />
  }
}

function Icon({ path, className }: { path: string; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-3.5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}
