# 0043: Jump to the next result row, page or plan node

- **Status:** Accepted
- **Date:** 2026-10-14

## Context
[UX.md](../UX.md#playback) promised controls to jump to the next row emitted, page read or plan node, and [ADR 0042](0042-condensed-steps-over-the-trace.md) said how they'd land: search the trace forward from the events done, then land on the step holding that event, expanding its stretch when it's inside one. Two things were left open: which events count as "a row", "a page" and "a plan node", and what happens to the stretches a run of jumps expands.

## Decision
- **Three buttons** in the player bar, after **To the end**, labeled **Next** **row** **page** **node** (accessible names "Next result row", "Next page", "Next plan node"), each with a tooltip saying what it stops at.
- **What each stops at**, searched from the first event not yet played (`src/player/jump.ts`):
  - **row:** a row sent to the result (`row.emit` with a `resultIndex`). Rows passed up to a parent node aren't stops: the visitor is watching the result fill in.
  - **page:** a page asked for in shared buffers, found there or read from disk (`buffer.hit`, `buffer.read`), index pages and heap pages alike. Not a page read ahead that a Limit stopped the scan before reaching (`ahead`): it's shown when the scan stops, not where the scan goes.
  - **node:** a plan node starting or finishing, or a Limit stopping the nodes below it (`node.start`, `node.finish`, `limit.stop`): the moments the plan tree's statuses change.
- **Landing:** the player pauses on the step that has that event alone, so the caption, zones and results pane are that event's. An event inside a stretch expands the stretch, as **Expand** does.
- **Leaving an expanded stretch by a jump collapses it** when the next event is outside it. Jumping page by page through example 2 or row by row through example 4 keeps at most one stretch expanded, and the step count stays within the budget plus that one stretch. A stretch expanded by hand elsewhere stays expanded.
- **Jumping pauses**, like stepping. A button is disabled when nothing of its kind is left; its tooltip then says so.

## Consequences
- A visitor can go straight to the first row of a long Seq Scan, walk example 4's 1,001 rows one at a time, or go from node to node in example 10's Limit, Sort and bitmap scan, without scrubbing.
- The search runs from the current event on each render; it stops at the first match, so it reads only a few events, except when nothing of that kind is left and it reads the rest of the trace.
- Jumping can't go backward; **Step back**, the timeline and **To the start** do that.

## Alternatives considered
- **Leaving every stretch a jump enters expanded:** after 10 page jumps into example 2 the step count had grown by 12; across a whole scan it would undo condensing.
- **Collapsing every expanded stretch on a jump:** simpler to state, but it would undo a stretch the visitor expanded on purpose somewhere else.
- **Landing on the stretch without expanding it:** the caption would sum up the stretch rather than say the row or page jumped to, and every jump inside it would land on the same step.
- **"Page" meaning only pages read from disk:** with a warm cache there'd be none to jump to; the buffer zone shows hits and reads, so both count.
