# 0041: The Examples menu

- **Status:** Accepted
- **Date:** 2026-10-13

## Context
[ADR 0002](0002-sandbox-with-examples.md) promises an **Examples** menu of ready-made queries, one concept from *SQL Performance Explained* each; [UX.md](../UX.md#layout) puts it in the editor toolbar. Several examples are sequences rather than single queries (example 9 is SELECT, UPDATE, SELECT twice, VACUUM, SELECT), some change the database (CREATE INDEX, UPDATE, VACUUM), and the editor's text is the visitor's own work, remembered in their browser. The visitor can also change the database however they like between examples, in any order.

## Decision
- **One typed module, `src/examples.ts`,** holds the 12 examples: a title (the concept), a one- or two-sentence description of what to watch for, and steps, each a statement with a comment and, for a query, the plan Postgres picks on a fresh database (node headings, rows, heap and index pages read, and the counts the prose quotes). The menu, the Vitest suite, the exit criteria (`e2e/exit-criteria.spec.ts`) and [DATA.md](../DATA.md#example-queries-v1) all follow it. A test fails if the prose quotes a number the expected plans don't check.
- **Choosing an example replaces the editor's text**, as one step in the editor's undo history, so Cmd/Ctrl+Z brings the visitor's text back. No confirmation: undo is quicker, and a dialog on every example would be in the way. The menu's footer says so.
- **It doesn't run until the visitor presses Run.** The editor gets focus with the cursor on the first statement, scrolled to the top so the description shows first; Cmd/Ctrl+Enter or Run runs that statement.
- **A sequence loads whole, as statements under comments.** A header comment gives the title, the description, how to run it, and that the numbers are from a fresh database (with **Reset database** to get back to it). Each step has a numbered comment saying what it does or what to watch. Run (the statement under the cursor) walks it one statement at a time; Run all runs the whole sequence and shows the last query.
- **Examples work in any order, and again.** An example that creates an index names it and uses `CREATE INDEX IF NOT EXISTS`; examples 2, 3 and 7, whose point is the plan without an index, start with `DROP INDEX IF EXISTS` on that index, and drop only indexes the examples create. Example 9's UPDATE uses customer 335, whose orders no other example reads, so moving those rows doesn't change another example's pages. Run again, example 9's UPDATE is a HOT update (the rows' new page has room), so its heap fetches go 0, 3, 3, 0 instead of 0, 6, 3, 0; the example says so, and the tests expect it. Tests run all 12 on one database in order and then in reverse, and each twice on a fresh one.
- **The menu follows the WAI-ARIA menu button pattern.** Enter, Space or ↓ on the button opens it at the first example, ↑ at the last; ↑ ↓ Home End move (wrapping); Enter or Space chooses; Escape closes it and returns to the button; Tab or a click elsewhere closes it. Each item's name is its number and title, its description the sentence or two under it.
- **It looks like the rest of the toolbar**: `surface-1` with a `border-strong` edge, the focused or hovered item on `surface-2`, numbers in mono and descriptions in muted text, in both themes ([ADR 0016](0016-visual-identity.md)). No accent colors: none of their meanings apply. It's a popover in the top layer under its button, so the editor pane's edges don't clip it.
- **The menu claims the pointer from the panes' resize handles.** react-resizable-panels finds a handle by the pointer's position on the whole document, so a click on an item lying over a handle would focus the handle and close the menu. While the menu is open, a window listener marks pointer events on the menu as handled, which the library skips.

## Consequences
- A visitor's text is one undo away, but only in that page load: CodeMirror's history isn't saved, so after a reload the example is the text that's remembered.
- Running a long sequence means clicking into each statement in turn. Moving the cursor to the next statement after Run would make it quicker; that changes Run for all text, so it's left for later.
- An example's numbers are exact only on the starting data, or after other examples. A visitor's own indexes or updates can change them; the header comment points to **Reset database**.
- Dropping an example's own index (examples 2, 3 and 7) also drops it if the visitor made one by that name.

## Alternatives considered
- **Insert at the cursor**: keeps the visitor's text, but the editor fills up with examples, and Run all would run them all.
- **Run on choosing**: one click to an animation, but it would run a DROP INDEX or an UPDATE without the visitor seeing it first, and a sequence would run only its first step or all at once.
- **One menu item per step** (3a, 3b...): every step one click away, but 30 items, and the order between them lives only in the labels.
- **A confirmation before replacing**: safe, but a dialog on every choice, when undo already brings the text back.
