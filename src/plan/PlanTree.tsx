import type { Plan, PlanNode } from '../db/plan'

const integer = new Intl.NumberFormat('en-US')
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })

/**
 * The plan Postgres used, as a tree: each node with estimated vs. actual
 * rows, the pages it found in shared buffers (hits) or read into them
 * (reads), and its conditions. Children are the nodes it pulls rows from.
 * Below it, what planning and execution took. Planning's buffers (system
 * catalogs, index probes) aren't part of any node's.
 */
export function PlanTree({ plan }: { plan: Plan }) {
  return (
    <div className="p-3 text-xs" data-testid="plan-tree">
      <ul aria-label="Plan nodes">
        <PlanNodeItem node={plan.root} />
      </ul>
      <p className="mt-3 font-mono text-fg-muted" data-testid="plan-planning">
        Planning {decimal.format(plan.planningMs)} ms · buffers: hit {integer.format(plan.planningHit)} · read{' '}
        {integer.format(plan.planningRead)}
      </p>
      <p className="font-mono text-fg-muted">Execution {decimal.format(plan.executionMs)} ms</p>
    </div>
  )
}

function PlanNodeItem({ node }: { node: PlanNode }) {
  return (
    // Plain nested lists: the plan isn't interactive yet, so it isn't an ARIA tree.
    <li>
      <div className="rounded-md border border-line bg-surface-1 px-2.5 py-1.5" data-testid="plan-node">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-semibold text-fg">{node.title}</span>
          <span className="font-mono text-fg-muted" data-testid="plan-rows">
            rows {decimal.format(node.actualRows)}
            {node.loops > 1 && ` × ${integer.format(node.loops)} loops`} · est. {integer.format(node.estimatedRows)}
          </span>
          <span className="font-mono text-fg-muted" data-testid="plan-buffers">
            buffers: hit {integer.format(node.sharedHit)} · read {integer.format(node.sharedRead)}
          </span>
        </div>
        {node.details.length > 0 && (
          <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 font-mono">
            {node.details.map((detail) => (
              <div key={detail.label} className="contents">
                <dt className="text-fg-muted">{detail.label}</dt>
                <dd className="break-words text-fg">{detail.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="mt-1.5 ml-3 space-y-1.5 border-l border-line pl-3">
          {node.children.map((child, index) => (
            <PlanNodeItem key={index} node={child} />
          ))}
        </ul>
      )}
    </li>
  )
}
