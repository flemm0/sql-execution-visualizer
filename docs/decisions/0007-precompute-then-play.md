# 0007: Compute the full trace first, then play it back

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Learners need to pause, step backward, and scrub, not just watch.

## Decision
On Run, the worker computes the whole trace (with condensed stretches expanded lazily), then the player plays it back with:

- play/pause and step back/forward
- a timeline scrubber
- speed control (≈1–60 steps/s or instant)
- jump to the next row emitted / page read / plan node

## Consequences
Stepping backward and scrubbing are trivial. Playback starts after the trace is ready (expected to be well under a second).

## Alternatives considered
- Streaming the animation while computing: slightly faster start, but no stepping backward or scrubbing.
