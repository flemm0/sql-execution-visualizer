# 0013: Tech stack

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Claude writes most of the code; Flemming steers and reviews and is new to TypeScript. The stack should be mainstream, well documented, and readable.

## Decision

| Area | Choice |
|---|---|
| Build | Vite, React, TypeScript (static SPA, no server framework) |
| Database | PGlite 0.5.x in a Web Worker |
| SQL editor | CodeMirror 6 (schema-aware autocomplete; far lighter than Monaco) |
| Styling | Tailwind CSS with CSS-variable design tokens |
| Panes / state | react-resizable-panels, Zustand |
| Animation | SVG rendered by React, animated with Motion; Canvas only if needed |
| Tests | Vitest (PGlite in Node), Playwright smoke tests |

## Consequences
The largest ecosystem for editors, panes, and animation. Code favors conventional, readable TypeScript over clever types.

## Alternatives considered
- Next.js: unnecessary without a server.
- Monaco: several MB heavier.
- D3 or Canvas-first rendering: harder to read and test for the expected element counts.
