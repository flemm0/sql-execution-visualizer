# 0027: One player step per trace event; the state is rebuilt for each step

- **Status:** Accepted; the first bullet of the decision (one step is one trace event) is superseded by [0042](0042-condensed-steps-over-the-trace.md), and the last (a player per visualization, keyed by run) by [0029](0029-results-follow-the-player.md)
- **Date:** 2026-10-10

## Context
M2's player plays the traces of Seq Scans and Index Scans ([ADR 0024](0024-seq-scan-trace-per-page.md), [ADR 0025](0025-index-scan-replay.md)) in the visualization pane, with play/pause, step back and forward and a scrubber ([ADR 0007](0007-precompute-then-play.md)). Condensing to the ~30 s budget comes in M3 ([ADR 0005](0005-realistic-data-and-30s-budget.md)).

Traces of the examples have 11 (example 1) to about 3,000 (examples 2 and 4) events. A Seq Scan of all of `order_items` has about 203,000. Measured in Node, rebuilding the state from the start takes about 18 ms at the end of that big trace, once only the last step's caption is written (about 130 ms when every step's caption was written).

## Decision
- **One step is one trace event.** The trace already has one event per action that [UX.md](../UX.md#playback) names (a page requested, an index page visited, an entry matched, a row fetched or a page gone through, a row emitted), plus a node starting and finishing.
- **The state at a step is rebuilt from the start of the trace** (`stateAt`), so stepping back and scrubbing take the same path as stepping forward, with no undo logic. It writes one caption, for the last event.
- **Captions are written by the player** from the event and the state after it, and use the plan nodes' titles. The trace stays plain data.
- **Speeds:** 1, 3, 10, 30 or 60 steps/s, or instant; **30 by default**, remembered in the browser. Example 1 plays in under half a second; examples 2 and 4 in about 100 s until condensing.
- Every run autoplays. The visualization is keyed by run, so a new run starts a new player at step 0.

## Consequences
- Simple, and easy to test: `stateAt` is a pure function of the trace and the position.
- Cost grows with the position: playing the end of a 200,000-row trace takes about 18 ms a step, fine at 30 steps/s. M3's condensing makes those traces far shorter to play; if a longer trace becomes a problem, keep checkpoints of the state every few thousand steps.
- Uncondensed, the big examples are long at the default speed: **To the end** and instant speed are the way through until M3.

## Alternatives considered
- **Applying events forward and undoing them backward:** fast at any position, but every event type needs an undo, and a bug in one shows a state that never happened.
- **A snapshot of the state after every step:** instant seeking, but memory grows with the trace (each state holds the pages used so far).
- **Steps that group a buffer access with what follows it** (e.g. "read heap page 12 and check its rows"): fewer steps, but a hit or a read is the thing [UX.md](../UX.md) wants learners to see, and grouping is M3's condensing.
