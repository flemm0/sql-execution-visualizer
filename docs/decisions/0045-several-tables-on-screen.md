# 0045: Several tables on screen: relation cards and a detail area that follows the scan

- **Status:** Accepted
- **Date:** 2026-10-14

## Context
The visualization pane has three zones (index, shared buffers, heap) for the one table a v1 query reads ([UX.md](../UX.md#visualization)). v2's examples read two to four tables ([DATA.md](../DATA.md#example-queries-v2)), and some read one table twice (example 15 joins `categories` to itself). Each scan has its own index and heap. Shared buffers is one pool the whole query shares, and the page numbers of different tables collide: `h17` could be a page of `customers` or of `orders`.

A Nested Loop hands control back and forth: the outer scan finds a row, then the inner scan runs once for it (a "loop"), then the outer scan finds the next row. Example 13 switches between the two 38 times. Hash joins and aggregates add work that isn't a scan at all: building a hash table, probing it, collecting groups.

The pane is about a third of the window's height. A B-tree drawn the way [ADR 0028](0028-index-pages-in-the-trace.md) draws it needs most of that height for its two or three levels. Principle 2 (digestible) asks for one action per step and only the pages that matter in detail. [Issue #28](https://github.com/flemm0/sql-execution-visualizer/issues/28) proposes linking the three zones with a ctid thread, which the layout chosen here has to make room for.

## Decision
**Focus and context:** every scan is always on screen as a small card, and one scan at a time gets the full zones.

- **Relation cards:** a row of cards across the top of the pane, one per scan node in the plan, in plan order (outer before inner). Each card has the table (and index) with the query's alias (`orders o`, by `orders_customer_id_order_date_idx`), a small mini-map scaled to the card's width (several pages per square, marked as the full mini-map marks them), the node's hit and read counts, its rows passed on so far, and for a node that runs more than once, its loop ("loop 12 of 38"). The card of the scan working at the current step is outlined. A table scanned twice (example 15) gets two cards, one per alias.
- **Detail area:** under the cards, the v1 zones (index, shared buffers, heap) show the scan working at the current step. When the step moves to another scan, the detail area moves with it, instantly, without animation, so stepping back and forth stays exact. Clicking a card **pins** it: the detail area stays on that scan, and a "Pinned: orders o · follow the step" control unpins. While pinned, steps of other scans still update the cards, the shared buffers zone and the caption.
- **Shared buffers zone:** one zone for the whole query, as in v1, since it is one pool. Each slot label starts with the alias of the table it belongs to (`c·h17`, `o·i57`, `o·h212`), and its hover text names the table in full, as it does now ([ADR 0044](0044-hover-info-on-slots-and-mini-map.md)). Slots of the scan in the detail area are drawn at full strength and the others are dimmed, as non-current slots are now.
- **Node zone:** a column at the right of the detail area for the node working at the current step when it isn't a scan. v1's Sort zone becomes the first case of it. For a Nested Loop, it shows the outer row in amber and the parameter it hands the inner scan ("customer 4242 → search orders for customer_id = 4242"), and the inner rows matched so far for that outer row. When the step is in a scan, the node zone shows the join that scan feeds, so the reason for the switch stays on screen. Hash tables (M5), groups (M5, M6) and CTE stores (M7) are drawn here, in violet, the color for intermediate results. Each milestone's own ADR settles how.
- **Issue #28 lands in M4, inside the detail area.** Its ctid thread runs from the leaf entry, through the buffer slot, to the heap row of the scan in the detail area. Its column of buffer slots replaces the wrapped row. Building it before this change would have meant laying out the zones twice.
- **Single-table queries look as they do in v1:** a plan with one scan node and no other node that needs the node zone shows no cards and no node zone.
- **Captions name the table** whenever a query reads more than one ("Index page 57 of `orders` isn't in shared buffers…"), and each step's caption says when the detail area switches to another scan ("Loop 13: the inner Index Scan on orders o searches for customer 4318.").

## Consequences
- Every table and its progress stay visible, while the detailed picture stays as large and readable as in v1.
- The detail area switches a lot during a Nested Loop. The cards, the node zone's outer row and the caption carry the thread between switches. Pinning lets a visitor watch one side through every loop.
- Condensing ([ADR 0042](0042-condensed-steps-over-the-trace.md)) puts a whole loop of the inner scan into a stretch. A stretch's zones show its last event, so the detail area shows whichever scan that is.
- The cards take height from the detail area, about 70 px. On a short window the B-tree drops sibling boxes sooner, as it already does in a narrow zone.
- The playback state (`stateAt`) has to keep a state per scan node (its search, its current heap page, its pages touched) instead of one. Today it keeps one, because v1 plans have one scan, or one bitmap pair.
- Slot labels get longer by an alias and a dot. With a column of slots (issue #28) there is room for that.

## Alternatives considered
- **A lane per table, stacked:** everything visible at once, but four tables would leave each lane under 80 px, too short for a B-tree. One active lane among three idle ones also wastes most of the space.
- **A column per table, side by side:** works for two tables, but four would make each column too narrow for an index page's keys.
- **Draw the plan as the visualization** (one box per node, pages inside): shows the data flow directly, but duplicates the plan pane, and the page-level picture, the app's point, would shrink to fit every box.
- **A tab per table in the visualization pane:** keeps each picture large, but a visitor would have to click to see the inner scan of a Nested Loop, and would miss the back-and-forth that defines it.
- **Follow the step with no pinning:** simpler, but with a 38-loop join the outer scan's picture keeps disappearing; pinning costs one control.
