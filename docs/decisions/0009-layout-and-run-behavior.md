# 0009: Five-pane layout and run behavior

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Flemming's four panes (editor, visualization, results, schema browser) needed homes for the plan and for intermediate results.

## Decision
- **Layout:**
  - schema browser on the left
  - editor and plan tree on top
  - visualization in the middle
  - results tabs at the bottom (Final plus one tab per intermediate result)

  All panes are resizable and collapsible.
- **Running statements:**
  - `Cmd/Ctrl+Enter` runs the statement under the cursor; **Run all** runs everything.
  - SELECTs autoplay (a setting can switch autoplay off).
  - Results build up as rows are emitted; **Skip to end** shows them instantly.
  - When idle, the visualization pane browses any table's or index's pages.

Details and mockups: [UX.md](../UX.md).

## Consequences
The plan tree always sits next to the animation it drives. Intermediate results have a natural home for v2.

## Alternatives considered
- Plan tree inside the visualization pane: cramped.
