# 0031: The plan tree follows the player

- **Status:** Accepted
- **Date:** 2026-10-11

## Context
[UX.md](../UX.md#layout) wants the plan tree, during playback, to highlight the node working now and show each node's actual rows so far next to its estimate. The tree showed only Postgres's totals. Since [ADR 0029](0029-results-follow-the-player.md), App owns the one player, so the plan pane can read the same step as the visualization and the results pane.

v1 plans that replay have a single node, but v2's joins and aggregates have several working at once: a parent stays busy while its child produces the rows it pulls.

## Decision
- **Each node's progress comes from the trace** (`nodeProgressAt`): *waiting* until its `node.start`, *active* until its `node.finish`, then *done*; and its rows so far are its `row.emit` events, whether they go to its parent or to the result. Several nodes can be active at once (a parent and the child it's pulling from).
- **Active nodes are outlined and marked "◀ active"** in the neutral foreground color, not an accent: each accent already has one meaning ([UX.md](../UX.md#color-meanings)). The node also gets `aria-current="step"`.
- **Rows read "rows 58 so far of 189 · est. 5"**: the count so far, against Postgres's total (actual rows × loops) and the planner's estimate.
- **At the last step the tree shows Postgres's totals alone**, with no highlight, as before; likewise for a query with nothing to animate.

## Consequences
- Truthful: the rows so far are the trace's, and the validator checks the trace's rows and buffer counts per node against Postgres's.
- One more pass over the trace up to the step on each render, like `resultRowsAt`: about a millisecond at the end of the largest traces.
- Per-node buffer hits and reads so far aren't shown yet; the visualization's counters cover them for single-node plans. They can join when v2's plans have several nodes reading pages.

## Alternatives considered
- **Using `stateAt`'s `activeNode`**: it holds one node, so a parent would look idle while its child works.
- **Counting only rows sent to the result**: a child node in v2 sends its rows to its parent, so it would always read 0.
- **An accent color (sky) for the active node**: sky means index pages.
