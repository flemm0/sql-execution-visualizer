import { useEffect, useRef, useState } from 'react'
import { NODE_HEIGHT, layoutBtree, type Cell, type LayoutInput, type LinkShape, type PageShape, type RowPointer } from './btreeLayout'

/** The width to lay out for before the zone has been measured. */
const STARTING_WIDTH = 480

/**
 * The B-tree the current search walks, drawn as textbooks draw one: each
 * page a row of keys, a pointer in each gap leading down to a child page, the
 * pointer the search followed in sky. btreeLayout.ts decides what goes where.
 */
export function BtreeView(props: Omit<LayoutInput, 'width'>) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(STARTING_WIDTH)

  // Lays the tree out for the zone's real width, again whenever it's resized.
  useEffect(() => {
    const element = container.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = layoutBtree({ ...props, width })
  const currentBlock = layout.pages.find((page) => page.current)?.block ?? null

  // Keeps the page the step is on in view when the zone is too short for the whole tree.
  useEffect(() => {
    container.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'nearest' })
  }, [currentBlock])

  return (
    <div ref={container} className="w-full">
      <svg
        width={layout.width}
        height={layout.height}
        className="font-mono text-[11px]"
        role="img"
        aria-label="The B-tree pages this search went through"
        data-testid="viz-btree"
      >
        <defs>
          <marker id="btree-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--text-secondary)" />
          </marker>
          <marker id="btree-arrow-index" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--accent-index)" />
          </marker>
          <marker id="btree-arrow-heap" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--accent-heap)" />
          </marker>
          <marker id="btree-arrow-intermediate" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--accent-intermediate)" />
          </marker>
        </defs>
        {layout.links.map((link, i) => (
          <Link key={i} link={link} />
        ))}
        {layout.ghosts.map((ghost, i) => (
          <g key={i} data-testid="viz-btree-ghost">
            <rect
              x={ghost.x + 0.5}
              y={ghost.y + 0.5}
              width={ghost.width - 1}
              height={NODE_HEIGHT - 1}
              rx={4}
              fill="none"
              stroke="var(--border-strong)"
              strokeDasharray="3 3"
            />
            <text x={ghost.x + ghost.width / 2} y={ghost.y + NODE_HEIGHT / 2} textAnchor="middle" dominantBaseline="central" fill="var(--text-secondary)">
              {ghost.text}
            </text>
          </g>
        ))}
        {layout.pages.map((page) => (
          <Page key={`${page.block}-${page.compact}`} page={page} />
        ))}
        {layout.rowPointer && <RowPointerArrow pointer={layout.rowPointer} />}
      </svg>
    </div>
  )
}

function Link({ link }: { link: LinkShape }) {
  const style = {
    down: { stroke: 'var(--accent-index)', width: 1.5, dash: undefined, marker: 'url(#btree-arrow-index)' },
    sibling: { stroke: 'var(--border-strong)', width: 1, dash: '3 3', marker: undefined },
    right: { stroke: 'var(--text-secondary)', width: 1, dash: undefined, marker: 'url(#btree-arrow)' },
  }[link.kind]
  return (
    <line
      x1={link.x1}
      y1={link.y1}
      x2={link.x2}
      y2={link.y2}
      stroke={style.stroke}
      strokeWidth={style.width}
      strokeDasharray={style.dash}
      markerEnd={style.marker}
      data-testid="viz-btree-link"
      data-kind={link.kind}
    />
  )
}

/** The arrow from the latest match down to its heap row (amber), or into the bitmap (violet: an intermediate result). */
function RowPointerArrow({ pointer }: { pointer: RowPointer }) {
  const color = pointer.kind === 'bitmap' ? 'var(--accent-intermediate)' : 'var(--accent-heap)'
  const marker = pointer.kind === 'bitmap' ? 'url(#btree-arrow-intermediate)' : 'url(#btree-arrow-heap)'
  return (
    <g data-testid="viz-btree-row" data-kind={pointer.kind}>
      <line x1={pointer.x} y1={pointer.y1} x2={pointer.x} y2={pointer.y2 - 12} stroke={color} markerEnd={marker} />
      <text x={pointer.x} y={pointer.y2} textAnchor="middle" fill={color}>
        {pointer.text}
      </text>
    </g>
  )
}

/** A page: its label above, then its row of keys and gaps. */
function Page({ page }: { page: PageShape }) {
  const [name, ...rest] = page.label.split(' · ')
  return (
    <g
      transform={`translate(${page.x}, ${page.y})`}
      data-testid="viz-btree-page"
      data-block={page.block}
      data-current={page.current ? '' : undefined}
      data-compact={page.compact ? '' : undefined}
    >
      <text x={0} y={-5} className="text-[10px]">
        <tspan fill="var(--accent-index)">{name}</tspan>
        {rest.length > 0 && <tspan fill="var(--text-secondary)"> · {rest.join(' · ')}</tspan>}
      </text>
      <rect
        x={0.5}
        y={0.5}
        width={page.width - 1}
        height={NODE_HEIGHT - 1}
        rx={4}
        fill="var(--surface-1)"
        stroke={page.current ? 'var(--accent-index)' : 'var(--border-strong)'}
        strokeWidth={page.current ? 2 : 1}
      />
      {page.cells.map((cell, i) => (
        <CellShape key={i} cell={cell} divider={i > 0 && !page.compact} />
      ))}
    </g>
  )
}

const MARK_FILL: Record<string, { fill: string; opacity: number; text: string }> = {
  followed: { fill: 'var(--accent-index)', opacity: 0.35, text: 'var(--text-primary)' },
  current: { fill: 'var(--accent-index)', opacity: 0.35, text: 'var(--text-primary)' },
  matched: { fill: 'var(--accent-index)', opacity: 0.12, text: 'var(--accent-index)' },
  markedDead: { fill: 'none', opacity: 0, text: 'var(--text-secondary)' },
  dead: { fill: 'none', opacity: 0, text: 'var(--text-secondary)' },
}

/** A key, the gap between two keys (where a pointer starts), or "…" for keys left out. */
function CellShape({ cell, divider }: { cell: Cell; divider: boolean }) {
  const mark = cell.mark === null ? null : MARK_FILL[cell.mark]
  const struck = cell.mark === 'dead' || cell.mark === 'markedDead'
  return (
    <g data-testid="viz-btree-cell" data-kind={cell.kind} data-mark={cell.mark ?? undefined} data-offset={cell.offset ?? undefined}>
      {cell.title && <title>{cell.title}</title>}
      {mark && mark.opacity > 0 && (
        <rect x={cell.x + 1} y={1} width={cell.width - 2} height={NODE_HEIGHT - 2} rx={3} fill={mark.fill} fillOpacity={mark.opacity} />
      )}
      {divider && <line x1={cell.x} y1={0} x2={cell.x} y2={NODE_HEIGHT} stroke="var(--border)" />}
      {cell.kind === 'gap' ? (
        // A pointer starts here: a dot at the bottom of the gap.
        <circle
          cx={cell.x + cell.width / 2}
          cy={NODE_HEIGHT - 5}
          r={2.5}
          fill={cell.mark === 'followed' ? 'var(--accent-index)' : 'var(--text-secondary)'}
        />
      ) : (
        <text
          x={cell.x + cell.width / 2}
          y={NODE_HEIGHT / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill={mark?.text ?? (cell.kind === 'ellipsis' ? 'var(--text-secondary)' : 'var(--text-primary)')}
          textDecoration={struck ? 'line-through' : undefined}
        >
          {cell.text}
        </text>
      )}
    </g>
  )
}
