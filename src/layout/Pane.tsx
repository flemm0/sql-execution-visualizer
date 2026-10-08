import { useState, type ReactNode } from 'react'
import { Panel, Separator, usePanelRef } from 'react-resizable-panels'

/** Size of a collapsed pane in pixels: the height of its title bar, or the width of the strip left behind. */
const COLLAPSED_SIZE = 36

/**
 * The direction a pane shrinks toward when collapsed. Panes collapsing left or
 * right become a narrow strip with a vertical title; panes collapsing up or
 * down keep only their title bar.
 */
export type CollapseToward = 'left' | 'right' | 'up' | 'down'

interface PaneProps {
  /** Identifies the pane in saved layouts; also becomes the element's id and data-testid. */
  id: string
  title: string
  collapseToward: CollapseToward
  /** Starting size as a percentage of the surrounding group, for example "20". */
  defaultSize: string
  /** Smallest size in pixels before the pane collapses. */
  minSize: number
  /** Buttons shown on the right of the title bar. */
  toolbar?: ReactNode
  children: ReactNode
}

/** One resizable, collapsible pane of the workspace, with a title bar. */
export function Pane({ id, title, collapseToward, defaultSize, minSize, toolbar, children }: PaneProps) {
  const panelRef = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const collapsesToStrip = collapseToward === 'left' || collapseToward === 'right'

  function toggle() {
    if (collapsed) panelRef.current?.expand()
    else panelRef.current?.collapse()
  }

  // The library resizes the pane (dragging, the keyboard, a saved layout, or
  // toggle above) and then calls onResize, so the collapsed flag follows it.
  const collapseButton = (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
      title={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
    >
      <Chevron pointing={collapsed ? opposite(collapseToward) : collapseToward} />
    </button>
  )

  return (
    <Panel
      id={id}
      panelRef={panelRef}
      defaultSize={defaultSize}
      minSize={minSize}
      collapsible
      collapsedSize={COLLAPSED_SIZE}
      onResize={() => setCollapsed(panelRef.current?.isCollapsed() ?? false)}
    >
      <section aria-label={title} className="flex h-full flex-col overflow-hidden">
        {collapsed && collapsesToStrip ? (
          <div className="flex h-full flex-col items-center gap-2 bg-surface-1 py-1">
            {collapseButton}
            <h2 className="text-fg-muted [writing-mode:vertical-rl]">{title}</h2>
          </div>
        ) : (
          <>
            <div
              className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-1 pr-1 pl-3"
              style={{ height: COLLAPSED_SIZE }}
            >
              <h2 className="truncate">{title}</h2>
              <div className="ml-auto flex items-center gap-2">
                {!collapsed && toolbar}
                {collapseButton}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto" hidden={collapsed}>
              {children}
            </div>
          </>
        )}
      </section>
    </Panel>
  )
}

/** The draggable line between two panes. `between` is the direction the panes sit next to each other. */
export function ResizeHandle({ between }: { between: 'columns' | 'rows' }) {
  const size = between === 'columns' ? 'w-px' : 'h-px'
  return (
    <Separator
      className={`${size} bg-line outline-none focus-visible:bg-index data-[separator=active]:bg-index data-[separator=hover]:bg-index`}
    />
  )
}

function opposite(direction: CollapseToward): CollapseToward {
  const opposites: Record<CollapseToward, CollapseToward> = { left: 'right', right: 'left', up: 'down', down: 'up' }
  return opposites[direction]
}

function Chevron({ pointing }: { pointing: CollapseToward }) {
  const rotation: Record<CollapseToward, number> = { down: 0, left: 90, up: 180, right: 270 }
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      style={{ transform: `rotate(${rotation[pointing]}deg)` }}
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
