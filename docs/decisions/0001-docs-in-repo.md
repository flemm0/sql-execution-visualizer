# 0001: Project docs live as Markdown in the repo

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Flemming and Claude both need a shared, current description of the project's goals and design.

## Decision
Docs are Markdown files in `docs/`, with one decision record per decision in `docs/decisions/`. The root `CLAUDE.md` indexes them; Claude Code loads it every session.

## Consequences
Docs are versioned with the code and change in the same PR as the design they describe. GitHub renders them for reading.

## Alternatives considered
- A Claude Doc on claude.ai: nicer to comment on, but lives outside the repo and drifts from the code.
- Notion: same drawback.
