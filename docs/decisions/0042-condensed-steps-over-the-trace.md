# 0042: Condensed steps over the unchanged trace, to a fixed budget of 900 steps

- **Status:** Accepted; supersedes the first bullet of [0027](0027-player-steps-and-state.md) (one step is one trace event)
- **Date:** 2026-10-13

## Context
[ADR 0005](0005-realistic-data-and-30s-budget.md) wants every animation to finish in about 30 seconds at normal speed: early pages row by row, then a page at a time, matching rows still flashing individually, and every condensed stretch expandable, with its detail computed only on expansion. Until now one player step was one trace event ([ADR 0027](0027-player-steps-and-state.md)), so the long examples took minutes.

Measured on the seed data, empty cache, at the default 30 steps/s:

| Case | Plan | Events | Uncondensed | Condensed steps | Condensed |
|---|---|---:|---:|---:|---:|
| 1 | Index Scan | 11 | 0.4 s | 11 | 0.4 s |
| 2 | Seq Scan, 1,278 pages, 189 rows | 2,747 | 92 s | 884 | 29.5 s |
| 3 | Bitmap Heap Scan | 753 | 25 s | 753 | 25 s |
| 4 | Index Scan, 1,001 rows | 3,029 | 101 s | 520 | 17.3 s |
| 5, pending | Index Scan, 1,498 rows | 4,521 | 151 s | 764 | 25.5 s |
| 5, delivered | Seq Scan, 45,000 rows | 46,180 | 25.7 min | 677 | 22.6 s |
| 6 | Bitmap Heap Scan, 944 rows | 3,325 | 111 s | 659 | 22.0 s |
| 7 (three plans) | Seq Scan, bitmap, Index Scan | 255, 13, 11 | ≤ 8.5 s | same | same |
| 8 (two plans) | bitmap, Seq Scan | 155, 295 | ≤ 9.8 s | same | same |
| 9 | Index Only Scan | 17 | 0.6 s | 17 | 0.6 s |
| 10 (two plans) | Limit over a backward scan; over a Sort | 24, 32 | ≤ 1.1 s | same | same |
| 11 | Seq Scan, 1 page | 5 | 0.2 s | 5 | 0.2 s |
| 12, clustered | Index Scan, 500 rows | 1,515 | 51 s | 514 | 17.1 s |
| 12, scattered | Bitmap Heap Scan, 468 rows | 1,727 | 58 s | 493 | 16.4 s |
| 12 as an Index Scan | 312 heap pages, 154 revisits | 1,879 | 63 s | 483 | 16.1 s |
| Sort of 944 rows | Sort over a bitmap scan | 4,272 | 142 s | 750 | 25.0 s |
| Top-N of 50,000 | Limit, Sort, Seq Scan | 101,185 | 56 min | 816 | 27.2 s |
| All of `order_items` | Seq Scan, 200,582 rows | 203,140 | 1.9 h | 800 | 26.7 s |

Condensing takes under 30 ms for every example, and about 0.2 s for the 203,140-event trace, in Node.

## Decision
- **The trace doesn't change.** Condensing makes a separate list of **steps** over it (`src/player/condense.ts`): each step is a range of consecutive events, the steps cover every event exactly once, in order, and the state after a step is `stateAt(trace, nodes, step.end)`. A step of several events is a **stretch**. The validator, `stateAt`, `resultRowsAt` and `nodeProgressAt` all keep working by event index, so condensing can't change what the validator checks or what the result shows.
- **One budget for the whole plan: 900 steps**, 30 seconds at the default 30 steps/s. A trace of at most 900 events plays one event per step, as before (examples 1, 3, 7, 8, 9, 10 and 11). Per-node budgets were rejected (below).
- **Units.** A longer trace is cut into units, one page or one row of work, by which event follows which:
  - **Seq Scan:** the buffer access, the page (`heap.page`) and the rows it sends on.
  - **Index Scan, Index Only Scan:** the matching entry, the heap page's buffer access, the visibility map check, the fetch (`heap.tuple`) and the row passed on.
  - **Bitmap Index Scan:** each entry marked in the bitmap. **Bitmap Heap Scan:** the page's buffer access with its first marked row; then each further row.
  - **Sort:** each row passed on; a row passed up to it carries its `sort.keep` or `sort.discard`. **Limit:** its `limit.skip` rides with the row it skips, and the row it passes on with the row that came up.
  - **Never in a stretch (fixed):** a node starting or finishing, a search down the index and each index page visited (with its buffer access), entries marked dead, a Sort switching to a top-N heapsort or sorting, a Limit stopping.
- **Stretches.** Consecutive units between fixed steps are grouped into stretches of at most *size* units, and the smallest size that fits the budget wins. Bigger stretches never make more steps, so a binary search finds it.
- **Rows flash when they can.** First the rows sent to the result (and rows a top-N heapsort keeps) are steps of their own and stretches only hold the work between them. If that can't fit the budget, because every row and the work before it come to more than 900 steps (examples 4, 5, 6 and 12), they ride in the stretches instead, and each stretch's caption names its result rows ("2 rows go to the result: rows 502 to 503"). A Seq Scan's page then carries its matching rows, so a step is the UX's "page 37: 85 rows checked, 81 matched" (example 5's common status).
- **Early detail.** At the start of each phase (a node starts or finishes, a Sort has sorted), units play event by event until 12 events have: the first pages or rows of a scan show every step. If even one stretch per run doesn't fit with that, the early detail goes.
- **Summaries are counted, not stored.** A stretch's caption is written when it's on screen, from `summarize(trace, start, end)`: heap pages gone through, rows visible and passing the filter, entries matched, rows fetched, buffer reads and hits, rows passed up, rows dropped or kept by a top-N heapsort, rows skipped, result rows. The zones show the state after its last event.
- **Expanding is lazy.** A stretch on screen has an **Expand** button; it replaces the stretch's one step with one step per event, each remembering the stretch, and pauses on the first. Inside, the bar says which event of how many this is, with **Collapse**, which puts the one step back and pauses on it. Only the expanded stretch's steps are made; the events were in the trace all along.
- **Speed is steps per second over the steps being played**: the condensed steps, plus one per event of any expanded stretch. Instant still jumps to the last step.
- **What the page exposes:** the player's `data-steps` (steps to play), `data-events` (events in the trace) and `data-events-done`, and the step counter adds the event count when they differ ("step 120 / 884 (2,747 events)"). The exit criteria read `data-steps`.
- **Jump-to-next controls** ([ADR 0043](0043-jump-to-next.md)): they search the trace forward from the events done, then land on the step holding that event, expanding its stretch when the event is inside one, as `e2e/player.ts`'s `seekToEvent` does.

## Consequences
- Every example plays in at most 30 seconds at the default speed; so do a Sort of 944 rows, a top-N heapsort over 50,000 rows and a Seq Scan returning all 200,582 rows of `order_items`.
- Short traces are untouched, and the validator and the result pane work as before: result row *n* is still the *n*th row emitted, and stepping back over a stretch takes its rows away.
- Matching rows flash individually only when there are few enough; with hundreds, a step is a row (examples 4, 5 pending, 12) or a page with its rows (example 5 delivered), and its caption counts them.
- Stretch sizes are uniform across the plan's phases, so a step is about the same amount of work throughout one animation, but not across animations: example 2's stretches are 2 pages, `order_items` in full is up to 5 pages.
- The Seq Scan trace is still per page ([ADR 0024](0024-seq-scan-trace-per-page.md)): expanding a Seq Scan stretch gives its pages' buffer accesses, pages and rows, not each row checked. Row-level detail would have to be read during the run.
- The step count changes while a stretch is expanded, so a test can't rely on a step number meaning an event; e2e tests seek to an event with `seekToEvent`.

## Alternatives considered
- **Condensing the trace itself** (stretch events replacing the events they group): `stateAt` would need to apply summaries, the validator would see a different trace, and expanding would need the original back anyway.
- **A budget per plan node:** a node with little work (a Bitmap Index Scan's few entries, a Sort's 3 rows) would leave its share unused, and nodes would play at different grains in one animation.
- **Always one page per step:** example 2 would still be 1,278 page steps plus 189 rows (49 s), and an index scan's 500 rows on 6 pages would be 6 steps.
- **Speeding up instead of grouping** ([ADR 0005](0005-realistic-data-and-30s-budget.md)'s "smart speed-up"): 100,000 events in 30 s is over 3,000 steps a second, faster than the screen redraws.
- **Merging the least interesting neighbors until it fits:** fits more tightly, but stretches would group unrelated work and be hard to caption or predict.
