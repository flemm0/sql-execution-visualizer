# 0040: The Examples menu: what picking an example does

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
[ADR 0002](0002-sandbox-with-examples.md) promises an **Examples** menu of ready-made queries, one concept each ([DATA.md](../DATA.md#example-queries-v1)), and [UX.md](../UX.md#layout) puts it in the editor toolbar. Several examples are a sequence, not one query: example 9 is a SELECT, an UPDATE, the SELECT twice, VACUUM and the SELECT once more, and examples 3, 5 and 7 add an index part-way through. The editor's text is the visitor's own work and is remembered in the browser, so whatever the menu does to it has to be safe. Examples must also work in any order and when repeated, though they share one database with everything else the visitor does.

## Decision
- **Picking an example replaces the editor's text** with the example: its title and description as comments, then each statement under a comment saying what to watch for and the plan to expect (rows, heap pages or Heap Fetches, and the plan's nodes, indented as EXPLAIN does). The replacement is one step of the editor's undo history, kept apart from typing around it, so **Cmd/Ctrl+Z brings the visitor's text back**. The menu's footer says so. No confirmation dialog.
- **Nothing runs until the visitor presses Run.** The cursor goes to the first statement and the editor gets focus, so Cmd/Ctrl+Enter runs it. A multi-step example is walked the same way: the visitor puts the cursor on each statement in turn. Run all still works, but shows only the last query's animation.
- **Examples tidy up after themselves.** An example that adds an index starts with `DROP INDEX IF EXISTS` when its first query needs the index gone (3, 7), creates it with `CREATE INDEX IF NOT EXISTS` and an explicit name, and ends by dropping it, so it can be repeated and leaves the starting indexes for the others. Example 9's UPDATE writes the same values back and its VACUUM cleans up; it uses customer 345, whose orders no other example reads, so it doesn't move rows other examples count pages of. The text says the expected plans are for the sample data as it starts, and that **Reset database** restores it.
- **One typed module, `src/examples.ts`,** holds every example: title, description, and steps, each with its SQL and, for a query, the plan to expect. The menu, the editor text, the Vitest checks, the exit criteria (`e2e/exit-criteria.spec.ts`, now "all 12 examples, from the menu") and DATA.md's table agree because they read it or are checked against it. Prose never states a number: every number the editor shows comes from a step's `expect`, which the tests check against Postgres.
- **A WAI-ARIA menu button.** Enter, Space or ↓ opens the menu on the first example, ↑ on the last; ↑ ↓ Home End move (wrapping around), Enter or a click picks, Esc or Tab closes it and returns to the button, and a click outside closes it. Each item is read out as its title, with the description as its accessible description.
- **Drawn with the design tokens** ([ADR 0016](0016-visual-identity.md)): `surface-1` with a `line-strong` border, `surface-2` for the focused or hovered item, titles in `fg`, descriptions and numbers in `fg-muted`. No accent colors: none of their meanings apply. The menu is drawn into `<body>` (a React portal) because the pane's title bar clips what overflows it.
- **The editor wraps long lines** to the pane's width, so the examples' comments read without scrolling sideways in a narrow pane. This applies to the visitor's own SQL too.

## Consequences
- Picking an example by mistake costs one Cmd/Ctrl+Z, but only while the page is open: the undo history isn't saved, and the editor text saved in the browser becomes the example's.
- Stepping through a long example takes a click per statement. Moving the cursor to the next statement after Run would make it quicker, but it changes Run for all SQL; left for later.
- An example's numbers can be wrong after the visitor's own changes (an index on `order_items.product_id` changes example 2's plan). The examples say so and point to Reset database rather than undoing every change a visitor could make.
- Example 9's Heap Fetches differ on a repeat: the first time, the UPDATE's new versions go to other pages (the seed's pages are full) and get index entries of their own, 0 → 6 → 3 → 0; after its VACUUM has made room, the next UPDATE is a HOT update on the same pages, 0 → 3 → 3 → 0. The example states both, and the tests check both.
- Soft wrapping changes how long lines of the visitor's SQL look; nothing else about editing changes.

## Alternatives considered
- **Insert at the cursor:** keeps the visitor's text, but mixes two sets of statements, and Run all would run both.
- **Replace after a confirmation dialog:** safe, but a dialog on every pick, for something undo already reverses.
- **Run on pick:** one step less for single-query examples, but it would run DDL the visitor hasn't read (DROP INDEX, UPDATE, VACUUM), and multi-step examples would need a different rule.
- **A guided stepper (Next/Back buttons) for multi-step examples:** clearer for sequences, but a new UI for what the editor and Run already do; the later challenges panel may bring one.
- **Example text in a side panel instead of comments:** keeps the editor clean, but needs room the layout doesn't have yet, and the comments travel with the SQL if a visitor copies it.
