# UX and visual design

## Look and feel

Inspired by [datadriven.io](https://datadriven.io)'s practice-problem pages, with our own identity: our own name, logo, and layouts. We borrow the general feel, not a copy.

- **Fonts:** Instrument Sans (headings), Inter (UI text), Geist Mono (code, keys, page numbers). All are open-source.
- **Theme:** dark-first, near-black surfaces with hairline borders, plus a light theme toggle. All colors are CSS variables (design tokens) defined once.
- **Desktop-first:** minimum ~1280 px wide; small screens show a "best on desktop" notice.
- **Display name:** to be proposed in M1; the repo name and URL stay `sql-execution-visualizer`.

### Color meanings

Each accent color has one meaning everywhere: in the visualization, plan tree, and results tabs.

| Color | Meaning |
|---|---|
| Sky | Index pages and index entries |
| Amber | Heap (table) pages and rows |
| Emerald | Rows emitted to the result |
| Violet | Intermediate results (sort output, hash tables, materialized sets) |
| Red | Rows rejected by a filter |

## Layout

Five resizable, collapsible panes:

```
┌─────────────┬────────────────────────────┬──────────────────────────┐
│ Schema      │ SQL editor                 │ Execution plan (tree)    │
│ browser     │ [Run] [Examples ▾] [Reset] │ ▸ Limit                  │
│ ▾ public    │                            │   ▸ Index Scan  ◀ active │
│  ▾ orders   ├────────────────────────────┴──────────────────────────┤
│    columns  │ Visualization                                         │
│    indexes  │  B-tree index      Shared buffers      Heap (table)   │
│    stats    │  [root]→[leaf]…    [■][■][□][□]…       [p0][p1][p2]…  │
│  ▸ customers│  ⏮ ◀ ▶ ⏭  ───●──────  speed ▾   step 120 / 3,410     │
│             ├───────────────────────────────────────────────────────┤
│             │ Results  [Final: 12 rows] [Hash: 30] [Sort: 312]      │
└─────────────┴───────────────────────────────────────────────────────┘
```

- **Schema browser:** tables (rows, pages, size), columns and types, indexes (definition, levels, pages), and statistics freshness. Clicking a table or index opens its pages in the visualization pane.
- **Plan tree:** the real plan. During playback the active node is highlighted, and each node shows estimated rows vs. actual rows so far.
- **Results:** a **Final** tab plus one tab per intermediate result (v2+). Rows appear as the animation emits them.

## Visualization

Three zones show the path a page takes: **disk → shared buffers → executor**.

```
 ▸ Index Scan using orders_customer_id_order_date_idx  ◀ active   rows: 3 so far / est. 5

 INDEX (2 levels)                   SHARED BUFFERS           HEAP orders (412 pages)
 ┌ root (idx p3) ──────────┐       ┌────┬────┬─────┬──┐     ▫▫▪▫▫▫▫▫▪▫▫▫▫▫▫ mini-map
 │ … │ 38 │ 81 │ 120 │ …   │       │i3  │i57 │h212 │  │     ┌ heap page 212 ──────────┐
 └────────┬────────────────┘       └────┴────┴─────┴──┘     │ 1  · id 9310  cust 17   │
 ┌ leaf (idx p57) ─────────────────┐  hits 2 · reads 3      │ 4  ✓ id 9313  cust 42 → │
 │ 41→(88,2)  42→(212,4)  42→(301,1) │ ── TID (212,4) ────▶ │ …                       │
 └─────────────────────────────────┘                        └─────────────────────────┘
 💬 "Leaf entry 42 points to row (212,4). Heap page 212 wasn't in memory, so it was
     read from disk into a buffer. Row 4 is visible → sent to the result."
```

- **Index zone:** the B-tree path actually walked (root → internal → leaf), plus neighboring leaf pages when the scan walks sideways. Keys are decoded real values.
- **Shared buffers zone:** cache slots. A miss animates the page moving from disk into a slot; a hit flashes the slot. Running hit/read counters.
- **Heap zone:** the page being read in detail, plus a mini-map of the whole table with touched pages highlighted.
- **Captions:** every step has a one-sentence plain-language caption.
- **Show internals:** reveals line pointers, offsets, and tuple headers (`xmin`/`xmax`, infomask), plus visibility-map bits.
- **Idle mode:** with no query playing, the pane browses any table's or index's pages.
- Index and heap page numbers are separate (different files); labels always say which (`idx p57`, `heap page 212`).

## Playback

- The full trace is computed first, then played ([ADR 0007](decisions/0007-precompute-then-play.md)).
- **Controls:** play/pause, step back/forward, timeline scrubber, speed (≈1–60 steps/s, or instant), and jump to the next row emitted / page read / plan node.
- **One step = one action:**
  - visit an index page
  - match an index entry
  - request a page (hit or read)
  - examine a row
  - emit a row
- **~30 s budget at normal speed.** Early pages play row by row, then the player moves a page at a time ("page 37: 150 rows checked, 2 matched"). Matching rows still flash individually. Every condensed stretch can be expanded and stepped through in full ([ADR 0005](decisions/0005-realistic-data-and-30s-budget.md)).
- **Empty-cache toggle:** "Start with an empty cache" is on by default, so every page is first read from disk. Turn it off and rerun to see buffer hits.

## Running statements

- `Cmd/Ctrl+Enter` runs the statement under the cursor; **Run all** runs the whole editor in order.
- **SELECT:** the plan appears immediately and the animation autoplays (a setting can switch autoplay off; then it loads paused at step 0). Results fill in as rows are emitted; **Skip to end** reveals the final result instantly.
- **Other statements:** a status line ("CREATE INDEX: done, 18 ms"); the schema browser refreshes; no animation in v1.
- **SQL errors:** the Postgres error message is shown in the results pane.
- **Autovacuum notices** appear as small toasts ("autovacuum: analyzed orders").

## Defaults

- Results pane shows up to 1,000 rows plus the total count.
- With the OS "reduce motion" setting on, transitions are instant; stepping still works.
- Supported browsers: current desktop Chrome, Edge, Firefox, Safari.
- Real Postgres terms throughout, each with a glossary tooltip.
