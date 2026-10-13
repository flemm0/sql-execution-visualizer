import type { Plan, PlanNode } from '../db/plan'
import type { NodeProgress } from '../player/playback'
import type { Replay } from '../replay/replay'
import { isGlossaryTerm } from '../glossary/glossary'
import { NodeTitle, Term } from '../glossary/Term'
import { ReplayStatus } from './ReplayStatus'

const integer = new Intl.NumberFormat('en-US')
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })

/**
 * The plan Postgres used, as a tree: each node with estimated vs. actual
 * rows, the pages it found in shared buffers (hits) or read into them
 * (reads), and its conditions. Children are the nodes it pulls rows from.
 * Below it, what planning and execution took (planning's buffers, for system
 * catalogs and index probes, aren't part of any node's), and whether the
 * replay of the query matches what Postgres reported.
 *
 * While the animation plays, `progress` has each node's part in it so far
 * (by node id): the node working now is highlighted, and each node counts
 * the rows it has passed on so far. Null when nothing is playing, or at the
 * animation's last step, where the plan shows Postgres's totals alone.
 */
export function PlanTree({
  plan,
  replay,
  progress = null,
}: {
  plan: Plan
  replay: Replay | null
  progress?: Map<number, NodeProgress> | null
}) {
  return (
    <div className="p-3 text-xs" data-testid="plan-tree">
      <ul aria-label="Plan nodes">
        <PlanNodeItem node={plan.root} progress={progress} />
      </ul>
      <p className="mt-3 font-mono text-fg-muted" data-testid="plan-planning">
        Planning {decimal.format(plan.planningMs)} ms · buffers: <Term term="buffer hit">hit</Term>{' '}
        {integer.format(plan.planningHit)} · <Term term="buffer read">read</Term> {integer.format(plan.planningRead)}
      </p>
      <p className="font-mono text-fg-muted">Execution {decimal.format(plan.executionMs)} ms</p>
      {replay && <ReplayStatus replay={replay} />}
    </div>
  )
}

function PlanNodeItem({ node, progress }: { node: PlanNode; progress: Map<number, NodeProgress> | null }) {
  // This node's part in the animation so far; undefined when nothing is playing or the trace doesn't mention it.
  const sofar = progress?.get(node.id)
  const active = sofar?.status === 'active'
  return (
    // Plain nested lists: the plan isn't interactive yet, so it isn't an ARIA tree.
    <li>
      <div
        className={`rounded-md border px-2.5 py-1.5 ${active ? 'border-fg bg-surface-2' : 'border-line bg-surface-1'}`}
        data-testid="plan-node"
        data-status={sofar?.status}
        aria-current={active ? 'step' : undefined}
      >
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-semibold text-fg">
            <NodeTitle title={node.title} nodeType={node.nodeType} />
          </span>
          {sofar && (
            <span className={active ? 'text-fg' : 'text-fg-muted'} data-testid="plan-status">
              {active ? '◀ active' : sofar.status === 'stopped' ? 'stopped early' : sofar.status}
            </span>
          )}
          <span className="font-mono text-fg-muted" data-testid="plan-rows">
            {sofar ? (
              // Postgres's rows are per loop; the animation counts every row, so the total is rows × loops.
              <>rows {integer.format(sofar.rows)} so far of {integer.format(Math.round(node.actualRows * node.loops))}</>
            ) : (
              <>
                rows {decimal.format(node.actualRows)}
                {node.loops > 1 && ` × ${integer.format(node.loops)} loops`}
              </>
            )}{' '}
            · <Term term="estimated rows">est.</Term> {integer.format(node.estimatedRows)}
          </span>
          <span className="font-mono text-fg-muted" data-testid="plan-buffers">
            buffers: <Term term="buffer hit">hit</Term> {integer.format(node.sharedHit)} ·{' '}
            <Term term="buffer read">read</Term> {integer.format(node.sharedRead)}
          </span>
        </div>
        {node.details.length > 0 && (
          <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 font-mono">
            {node.details.map((detail) => (
              <div key={detail.label} className="contents">
                <dt className="text-fg-muted">
                  {isGlossaryTerm(detail.label) ? <Term term={detail.label} /> : detail.label}
                </dt>
                <dd className="break-words text-fg">{detail.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="mt-1.5 ml-3 space-y-1.5 border-l border-line pl-3">
          {node.children.map((child, index) => (
            <PlanNodeItem key={index} node={child} progress={progress} />
          ))}
        </ul>
      )}
    </li>
  )
}
