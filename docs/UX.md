# UX and visual design

## Look and feel

Inspired by [datadriven.io](https://datadriven.io)'s practice-problem pages, with our own identity: our own name, logo, and layouts. We borrow the general feel, not a copy.

- **Fonts:** Instrument Sans (headings), Inter (UI text), Geist Mono (code, keys, page numbers). All are open-source.
- **Theme:** dark-first, near-black surfaces with hairline borders, plus a light theme. A visitor's first visit follows their operating system's light/dark setting; the sun/moon button in the header switches themes, and the choice is remembered in that browser. All colors are CSS variables (design tokens) defined once in `src/index.css` and exposed to Tailwind as classes (`bg-surface-1`, `text-index`, …).
- **Desktop-first:** designed for ~1280 px and wider; windows narrower than 1024 px show a "built for desktop" notice.
- **Display name:** **Pagewalk** ([ADR 0019](decisions/0019-display-name-pagewalk.md)). The logo is three linked pages walked in order: index (sky), heap (amber), result (emerald). The repo name and URL stay `sql-execution-visualizer`.

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
│ ▾ postgres  │ [Run] [Examples ▾] [Reset] │ ▸ Limit                  │
│  ▾ public   │                            │   ▸ Index Scan  ◀ active │
│   ▾ Tables  ├────────────────────────────┴──────────────────────────┤
│    ▸ orders │ Visualization                                         │
│    ▸ produc…│  B-tree index      Shared buffers      Heap (table)   │
│             │  [root]→[leaf]…    [■][■][□][□]…       [p0][p1][p2]…  │
│ ─ details ─ │  ⏮ ◀ ▶ ⏭  ───●──────  speed ▾   step 120 / 3,410     │
│ Table orders├───────────────────────────────────────────────────────┤
│             │ Results  [Final: 12 rows] [Hash: 30] [Sort: 312]      │
└─────────────┴───────────────────────────────────────────────────────┘
```

- **Resizing and collapsing:** drag (or focus and use the arrow keys on) the line between two panes. Each pane's title bar has a collapse button; a collapsed side pane leaves a narrow strip with its title, and a collapsed top or bottom pane leaves its title bar. Pane sizes and collapsed panes are remembered in that browser.
- **Schema browser:** an object tree like pgAdmin's or Snowflake's: database → schemas → **Tables** → each table → **Columns** (with types; a key icon marks primary-key columns) and **Indexes**. Folders show their item count. It opens with the database, schemas and Tables folders expanded and the tables closed. Postgres's system schemas and the app's own `visualizer` schema are hidden; schemas a learner creates appear, even when empty. Clicking a row selects it and opens or closes it; the keyboard follows the WAI-ARIA tree pattern (arrows, Home/End, Enter). A **details panel** under the tree shows the selected object's facts from the catalog: a table's row estimate, heap pages and size; a column's type, nullability and primary key; an index's kind, B-tree levels, pages and definition. For a table it also shows how fresh its statistics are: whether autovacuum is on for it, its last vacuum and analyze (since the page loaded, when Postgres started), and rows changed since the last analyze, dead rows and rows inserted since the last vacuum, each next to the threshold at which autovacuum acts. After every run it reloads from the catalog, so new tables and indexes appear at once. Still to come: clicking a table or index to open its pages in the visualization pane (M2).
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
- **Empty-cache toggle:** the **Empty cache** checkbox in the editor toolbar ("start with an empty cache") is on by default, so before each query its tables' and indexes' pages are evicted and every page is first read from disk. Turn it off and rerun to see buffer hits. The choice is remembered in that browser.

## Running statements

- **Editor:** CodeMirror with Postgres syntax. It completes keywords, schemas, tables and columns from the live catalog, so a table created a moment ago completes too. Syntax colors stay neutral, because the accent colors are reserved for their meanings. The editor's text is remembered in that browser.
- `Cmd/Ctrl+Enter` (or **Run**) runs the statement under the cursor; `Shift+Cmd/Ctrl+Enter` (or **Run all**) runs the whole editor in order and stops at the first error.
- **Results pane:** one status line per statement ("SELECT: 3 rows, 2 ms", "CREATE INDEX: done, 18 ms", "UPDATE: 4 rows"), Postgres's notices under it, then the rows of the last statement that returned any. Values appear exactly as Postgres prints them (dates as `2024-02-29`, booleans as `t`/`f`), and NULL as a dimmed *NULL*.
- **Plan pane:** the plan of the last query in the run: each node's heading as in text EXPLAIN, actual vs. estimated rows, shared-buffer hits and reads, and its conditions (Index Cond, Filter, Rows Removed by Filter, …), plus planning time and the pages planning found cached or read (system catalogs, index probes; not part of any node's counts), and execution time. A run with no query leaves a note saying so.
- **SELECT:** the plan appears immediately and the animation autoplays (a setting can switch autoplay off; then it loads paused at step 0). Results fill in as rows are emitted; **Skip to end** reveals the final result instantly. (Until the animation exists, the plan and the full result appear together.)
- **Other statements:** a status line; the schema browser refreshes; no plan and no animation in v1.
- **SQL errors:** Postgres's message in the results pane, with its DETAIL and HINT, and the line and column it points at; clicking those puts the cursor there.
- **Autovacuum:** after each run (not inside an open transaction), tables over Postgres's autovacuum thresholds are vacuumed and/or analyzed. Each one gets a toast in the bottom-right corner, saying which counter crossed which threshold ("autovacuum: analyzed orders / 5,051 rows changed since the last analyze (threshold 5,050)"). Toasts close after 10 seconds or with ✕. The **Autovacuum** checkbox in the editor toolbar turns the simulator off, to study stale statistics; the choice is remembered in that browser. Run stays disabled until autovacuum and the schema refresh are done.

## Defaults

- Results pane shows up to 1,000 rows plus the total count.
- With the OS "reduce motion" setting on, transitions are instant; stepping still works.
- Supported browsers: current desktop Chrome, Edge, Firefox, Safari.
- Real Postgres terms throughout, each with a glossary tooltip.
