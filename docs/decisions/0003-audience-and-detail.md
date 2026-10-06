# 0003: Pitch at SQL developers new to internals; reveal more on demand

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
The level of abstraction drives every visual. Options ranged from heavily simplified (beginners) to raw page internals (enthusiasts).

## Decision
Target developers who write SQL but haven't looked under the hood (Winand's audience):

- Real Postgres terms, each with a glossary tooltip.
- A one-sentence caption on every animation step.
- A **show internals** toggle that reveals line pointers, tuple headers, and visibility bits.

## Consequences
The default view stays readable while staying truthful. Internals cost little because `pageinspect` provides the data anyway.

## Alternatives considered
- Beginner-level abstraction: conflicts with staying true to the engine.
- Internals by default: overwhelms the target learner.
