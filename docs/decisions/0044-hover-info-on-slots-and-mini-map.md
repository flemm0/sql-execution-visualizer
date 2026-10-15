# 0044: Hover info on buffer slots and the heap mini-map

- **Status:** Accepted
- **Date:** 2026-10-14

## Context
[Issue #21](https://github.com/flemm0/sql-execution-visualizer/issues/21): a buffer slot's only hover text was a native `title` ("Read from disk by this query"), and a mini-map square had none, so a visitor couldn't tell which page a slot or square was, or what its color meant, without the docs. It was M3's last polish item. A native `title` doesn't work from the keyboard or on touch screens, and the mini-map can hold 600 squares, so making each one a Tab stop wasn't an option.

## Decision
- **What a slot says:** the page in full, with its table or index ("Heap page 212 of orders", "Index page 57 of orders_pkey", "Visibility map page 0 of orders"); whether it was already in shared buffers when the query first asked for it (a hit) or the query read it from disk; for a page asked for more than once, how many times so far, split into reads and hits ("Asked for twice so far: 1 read from disk, 1 hit."); and for a page read ahead that a Limit stopped the scan before reaching, that it was. Each slot counts its own hits and reads in the playback state (`BufferSlot.hits`, `reads`), from the trace's `buffer.hit` and `buffer.read` events.
- **What a mini-map square says:** its page, or for a table over 600 pages the range it stands for ("heap pages 0 to 2"), and what each page went through, counted by mark ("1 read, gave rows to the result; 2 read, no rows to the result so far"), not just the strongest mark the square shows. The page being read now says so.
- **It follows the step:** the text is written from the state on screen, so stepping, scrubbing or playing with a slot hovered changes it.
- **How it shows:** in a tooltip that looks like a glossary term's ([ADR 0040](0040-glossary-tooltips.md)), a popover in the top layer next to the item, while the pointer is over it or it has focus. A tap on a touch screen focuses the item and shows it.
- **Keyboard:** the slots are one Tab stop, and the mini-map is another. The arrow keys, Home and End move between items, the way a toolbar or a grid works ("roving tabindex"), and Escape hides the text. The focused item's text is its description (`aria-describedby`) for screen readers; each mini-map square is an image named by its page.
- **Zone headings** needed nothing new: the glossary already explains "Shared buffers" and "Heap" there.
- Not shown, though the issue suggested it: at which step a slot was first used (step numbers change as stretches expand, [ADR 0042](0042-condensed-steps-over-the-trace.md)), and each page's own row counts (the state keeps them only for the page being read now).

## Consequences
- Every value comes from the trace through the playback state; nothing is estimated.
- Two more Tab stops in the visualization pane, however many slots and squares there are.
- The hover text is written by plain functions (`src/visualization/hoverInfo.ts`), tested with Vitest; the tooltip and keyboard behavior is a hook (`useItemTips`) any row of small items can use.
- During playback a slot can move under a still pointer as new slots arrive; the tooltip then describes the slot now under it.

## Alternatives considered
- **Keeping native `title`s and adding one to each square:** no keyboard or touch access, a long delay, and the browser's own styling.
- **A Tab stop per slot and square:** up to 640 Tab stops to get past the pane.
- **A line under each zone describing the hovered item:** works without popovers, but moves the zone's layout as it appears, and is far from the item on a wide mini-map.
