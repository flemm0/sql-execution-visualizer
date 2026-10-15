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
| Violet | Intermediate results (a bitmap scan's bitmap, sort output, hash tables, materialized sets) |
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
│ ─ details ─ │  ⏮ ◀ ▶ ⏭  ───●──────  speed ▾   step 120 / 884       │
│ Table orders├───────────────────────────────────────────────────────┤
│             │ Results  [Final: 12 rows] [Hash: 30] [Sort: 312]      │
└─────────────┴───────────────────────────────────────────────────────┘
```

- **Resizing and collapsing:** drag (or focus and use the arrow keys on) the line between two panes. Each pane's title bar has a collapse button; a collapsed side pane leaves a narrow strip with its title, and a collapsed top or bottom pane leaves its title bar. Pane sizes and collapsed panes are remembered in that browser.
- **Schema browser:** an object tree like pgAdmin's or Snowflake's: database → schemas → **Tables** → each table → **Columns** (with types; a key icon marks primary-key columns) and **Indexes**. Folders show their item count. It opens with the database, schemas and Tables folders expanded and the tables closed. Postgres's system schemas and the app's own `visualizer` schema are hidden; schemas a learner creates appear, even when empty. Clicking a row selects it and opens or closes it; the keyboard follows the WAI-ARIA tree pattern (arrows, Home/End, Enter). A **details panel** under the tree shows the selected object's facts from the catalog: a table's row estimate, heap pages and size; a column's type, nullability and primary key; an index's kind, B-tree levels, pages and definition. For a table it also shows how fresh its statistics are: whether autovacuum is on for it, its last vacuum and analyze (since the page loaded, when Postgres started), and rows changed since the last analyze, dead rows and rows inserted since the last vacuum, each next to the threshold at which autovacuum acts. After every run it reloads from the catalog, so new tables and indexes appear at once. Selecting a table or index also opens its pages in the visualization pane (see **Page browser** below).
- **Plan tree:** the real plan. While the animation plays, it follows the player's step ([ADR 0031](decisions/0031-plan-tree-follows-the-player.md)): the node working now is outlined and marked "◀ active", the others say "waiting", "done", or "stopped early" (a node a Limit stopped before it finished), and each node counts the rows it has passed on so far against Postgres's total and the planner's estimate ("rows 58 so far of 189 · est. 5"). At the last step the highlight goes and each node shows Postgres's totals ("rows 189 · est. 5").
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

- **Node line:** above the zones, the plan node working now (or that just finished), whether it's active, done or stopped, and the rows it has passed on so far (to the result, or for a bitmap index scan, into its bitmap) against the planner's estimate. A parent counts as active while its child works for it (a Sort while the scan below gives it rows).
- **Limit line:** under it, for a plan with a Limit, its rows so far against its LIMIT and OFFSET, and once it has them, that it stopped ("Limit · LIMIT 3: 3 passed on · stopped: it asks for no more rows"; [ADR 0037](decisions/0037-sort-and-limit-replay.md)).
- **Index zone:** the B-tree as the current search walks it, drawn the way textbooks draw one ([ADR 0028](decisions/0028-index-pages-in-the-trace.md)). One level per row, the root at the top. Each page is a row of its real keys (as Postgres writes them), with a pointer in each gap between two keys leading down to the child page holding the keys between them. Postgres stores each child's pointer with the lowest key the child can hold, and the first pointer with no key (minus infinity), so the pointer in the gap after a key is the downlink with that key. The pointer the search followed is sky, with a sky arrow down to the child page.
  - **Fitting real pages:** a page holds hundreds of keys, so it shows the few around the one that matters (up to three each side, fewer when the zone is narrow), with "…N…" counts for the rest. Long keys are cut with "…" (the full key on hover). Columns a downlink dropped (suffix truncation) show as `−∞`.
  - **The rest of a level:** the parent's other children show as faint dashed boxes left and right ("11 pages", "125 pages"), with dashed lines from the parent's neighboring pointers.
  - **The leaf:** its entries around the one matching now (highlighted) or the latest match; earlier matches are sky, and entries marked dead (before the query, or by it) are struck through. An amber arrow goes down from the latest match to the heap row it points at ("heap row (50,3)"); in a bitmap index scan, which marks the row in its bitmap instead of fetching it, the arrow is violet ("bitmap: row (50,3)").
  - **Moving along a level:** the leaves a scan reads along a level sit side by side, linked by arrows; earlier ones are small (their first and last keys), with a count for any left out between them, and the last is drawn in full. A backward scan (`ORDER BY ... DESC` on an ascending index) moves left, so its row runs right to left: the first leaf it read under the pointer it followed, the last on the left, arrows pointing left ([ADR 0038](decisions/0038-backward-index-scans.md)).
  - Each page is labelled above (`idx p13 · leaf`); the page the step is on is outlined in sky and scrolled into view. Above the tree: which search down from the root this is ("search 2"), how many entries matched on the leaf ("3 matched on leaf idx p57"), and how many the scan marked dead. High keys aren't drawn (textbook B-trees don't have them) unless **Show internals** is on. A scan that reads no index has no index zone.
- **Shared buffers zone:** one slot per page the query has asked for, labelled `i57` (index page) or `h212` (heap page), in sky or amber, or `vm0` (a page of the table's visibility map, amber with a dashed border), the latest 40 shown. A heap page a scan asked for ahead and never reached, because a Limit stopped it, has a dotted border. A read animates the page arriving from disk into its slot; a hit flashes the slot. Running hit and read counters, the pages used so far, and how many were already cached.
- **Heap zone:** a mini-map of the whole table, one square per page (several pages per square for tables over 600 pages, showing the strongest of their marks): pages the query has been through in amber, pages that gave rows to the result in emerald, pages an index-only scan didn't read because the visibility map marks them all-visible in sky (their rows came from the index), pages a bitmap marks and the scan hasn't read yet in violet, pages read ahead and never reached in faint amber, the current page outlined. For a bitmap scan, a violet line above it counts the bitmap's rows and pages and how many of those pages have been read ("bitmap: 944 rows on 480 pages · 69 of 480 read"): the index scan turns pages violet as it marks their rows, then the heap scan sweeps through them in physical order. Under it, the page being read now: for a Seq Scan, its visible and matching row counts (and on the page a Limit stopped it on, how many it checked before the stop); for an index-only scan, whether it's all-visible (not read, rows from the index) or not (rows fetched); for a bitmap heap scan, how many rows the bitmap marks on it; then its latest rows (6 at most), each marked as passing, passed up to a Sort or Limit ("→ Limit"), sent to the result (with its result row number, emerald), filtered out (red) or not visible. A row an UPDATE moved within the page shows the version the query saw.
- **Sort zone:** for a plan with a Sort, its rows in violet, the color for intermediate results ([ADR 0037](decisions/0037-sort-and-limit-replay.md)). A line says what it holds ("in memory: 37 rows"; "top-N heapsort: keeps the best 10 · 14,833 seen · 14,823 dropped"; "sorted 944 rows (quicksort) · 3 of 944 passed on"), and under it, 6 rows at most, each with its sort keys' values: while it collects them, the latest given; in a top-N heapsort, the best kept, in order, then the worst ("← worst kept", the one a new row has to beat); once sorted, the latest it passed on, numbered in sort order. The row of the step on screen is highlighted.
- **Captions:** every step has a one-sentence plain-language caption, written from the step's trace event (a stretch's sums up its events; see **Playback**) ("Index page 57 isn’t in shared buffers, so it’s read from disk into a buffer.", "The visibility map marks heap page 119 all-visible (every row on it is visible to every transaction), so the entry’s values are enough: row (119,59) isn’t fetched from the heap.", "Heap page 81, page 37 of 480 in the bitmap, has 2 rows marked. It isn’t in shared buffers, so it’s read from disk into a buffer.", "Row (175,1) (total 628.70) doesn’t sort before the worst row kept, (174,61) (total 6125.89), so it’s dropped.", "Limit has passed on its 3 rows (LIMIT 3), so it stops: it doesn’t ask Index Scan Backward using orders_customer_id_order_date_idx on orders for another row, which stops where it is."). Captions spell out "index page 57" and "heap page 212"; compact labels use `idx p57` and `h212`.
- **Mismatch warning:** when the replay doesn't match Postgres, a red-edged banner over the zones says so and points to the checks in the plan pane; the animation still plays.
- **Nothing to animate:** a query that can't be replayed shows why in the pane ("Animation isn’t available yet for Aggregate."), as the plan pane does.
- **Show internals:** a checkbox in the visualization pane's title bar, off by default and remembered in that browser ([ADR 0039](decisions/0039-show-internals.md)). It applies to the animation and the page browser alike, and only changes what they show: turning it on or off never reruns anything. On, it adds Postgres's own bookkeeping, every value as pageinspect read it, in neutral text (the accent colors keep their meanings):
  - **Index zone:** each page drawn in full ends with its high key after a dashed divider (`HK 4393`), the upper bound of its keys; the rightmost page on a level has none (`HK +∞`).
  - **Heap zone:** under the page being read, its header (how many line pointers it has, and where its free space starts and ends: `pd_lower`, `pd_upper`) and its visibility-map bits (`all-visible 1 · all-frozen 0`, or that the map doesn't cover the page yet). Under each listed row, its line pointer (`lp 3: tuple at byte 7,928, 81 bytes`, or dead, unused, a redirect) and tuple header: `xmin`, `xmax`, `t_ctid`, and `t_infomask` and `t_infomask2` in hex with the names Postgres gives their bits (`HEAP_XMIN_COMMITTED HEAP_XMAX_INVALID`). A row the query updated shows both versions. A page an index-only scan didn't read shows its map bits and says it has no header or line pointers to show.
  - These are the pages as the query left them: running it can set hint bits (`HEAP_XMIN_COMMITTED`) and prune row versions no one can see, so a row the scan found deleted can show a dead line pointer. A trace keeps line pointers for the first 2,000 rows it names; a later row says it wasn't captured.
- **Page browser:** selecting a table or index in the schema browser opens its pages in the pane, one page at a time, read from Postgres ([ADR 0032](decisions/0032-open-pages-from-the-schema-browser.md)). The animation pauses, and **Back to the animation** returns to it at the same step.
  - **A table** opens at heap page 0: a mini-map of its pages (click one to open it), the arrows and a page number box, and the page's line pointers, one per row version with its ctid (`(12,3)`, amber). A row the session can see shows its values as Postgres prints them. Every other line pointer says why it holds none: not visible (deleted, replaced by an UPDATE, or not committed), dead, unused, or a redirect to a newer version.
  - **A B-tree index** opens at its root (`idx p3 · root`): its downlinks, each a key and the child page it leads to (sky; click to go down); on a leaf, its entries, each a key and the heap rows it points at (amber; click to open that heap page with the row highlighted), dead entries struck through. **Back** retraces the way you came, **Root** goes to the top, and the arrows open the pages to the left and right. Truncated key columns show as `−∞`; keys of types the app can't decode yet show their bytes. Other index types say they can't be browsed yet.
  - With **Show internals** on, a table page also shows its header (`pd_lower`, `pd_upper`), its visibility-map bits, and a column with each line pointer and tuple header, as in the heap zone; an index page shows its high key ("high key (item 1): 4393", or none on the rightmost page of a level).
- Browsing leaves shared buffers as they were, so the next query's hits and reads are its own. A run with a query to animate takes the pane back; any other run leaves the page open and reads it again, so it shows what the statement changed.
- Index and heap page numbers are separate (different files); labels always say which (`idx p57`, `heap page 212`).

## Playback

- The full trace is computed first, then played ([ADR 0007](decisions/0007-precompute-then-play.md)).
- **Controls:** to the start, step back, play/pause, step forward, to the end, a timeline scrubber, speed (1, 3, 10, 30 or 60 steps/s, or instant; 30 by default, remembered in that browser), **Autoplay** (on by default, remembered in that browser; off, each run's animation waits paused at step 0, even at instant speed, and the change applies from the next run; [ADR 0033](decisions/0033-autoplay-setting.md)), and which step is showing ("step 120 / 884", followed by the trace's events when stretches condense them: "(2,747 events)"). Stepping pauses playback; the scrubber keeps playing from where it's dropped if it was playing. Playback stops at the last step; going back from there (to the start, or with the scrubber) stays paused, and Play at the last step starts over.
- **Jump to the next:** **Next** **row**, **page** and **node** buttons pause on the next row sent to the result, the next page asked for in shared buffers (a hit or a read, index or heap), or the next plan node starting or finishing (or a Limit stopping the nodes below it) ([ADR 0043](decisions/0043-jump-to-next.md)). They land on that event alone: one inside a stretch expands it, and leaving an expanded stretch by a jump collapses it again, so jumping through a long scan keeps at most one expanded. A button is disabled when nothing of its kind is left.
- **One action per event:** each trace event is one action, and a short trace plays one event per step ([ADR 0027](decisions/0027-player-steps-and-state.md)):
  - a plan node starts or finishes
  - start a search down the index, visit an index page
  - match an index entry (a bitmap index scan marks its row in the bitmap), mark entries dead
  - request a page (hit or read)
  - go through a heap page (a Seq Scan), or fetch and check a row (an Index Scan, or a row a bitmap marks)
  - emit a row (to the result, or up to a Sort or Limit)
  - a Sort switches to a top-N heapsort, keeps or drops a row in it, or sorts its rows
  - a Limit skips a row for its OFFSET, or stops
- **~30 s budget at normal speed:** at most 900 steps, 30 seconds at the default 30 steps/s, however much data the query touches ([ADR 0005](decisions/0005-realistic-data-and-30s-budget.md), [ADR 0042](decisions/0042-condensed-steps-over-the-trace.md)). A trace of up to 900 events plays one event per step. A longer one groups repetitive runs of real events into **stretches**, each one step:
  - **What a stretch holds:** whole pages or rows of a scan's work: a Seq Scan's page (its buffer access, the page and the rows it sends on), an index scan's row (the entry, the heap page's access, the fetch, the row passed on), a bitmap's marked entries, a Sort's rows passed on, a top-N heapsort's dropped rows. A node starting or finishing, a search down the index, each index page visited, and a Sort's or Limit's turning points are never in one.
  - **How big:** all stretches in an animation hold at most the same number of pages or rows: the fewest that fit the budget. Example 2 moves two pages at a time; example 12's Index Scan a row at a time.
  - **Early detail:** after a node starts (or finishes, or a Sort has sorted), the first pages or rows play event by event, 12 events or so.
  - **Matching rows flash individually** (and rows a top-N heapsort keeps), as steps of their own between stretches, when that fits the budget. With hundreds of rows it doesn't, and each stretch carries its rows: a step is then a row, or a page with its rows (example 5's common status: "Heap page 37: 85 rows visible to the query, checked against the filter; 81 pass. Buffers: 1 page read from disk into shared buffers. 81 rows go to the result: rows 3,077 to 3,157.").
  - **Captions:** a stretch's caption sums up its events, with exact counts taken from them: the heap pages it went through, rows visible and passing the filter, index entries matched, rows fetched, buffer reads and hits, rows passed up, dropped or skipped, and the result rows it sends ("Heap pages 418 to 419: 314 rows visible to the query, checked against the filter; none pass. Buffers: 2 pages read from disk into shared buffers."). The zones show the state after its last event.
  - **Expanding:** next to the caption, a stretch says how many events it groups, with **Expand**: its events become one step each, and the player pauses on the first. Inside, the bar says which event of how many it is ("event 2 of 4 in an expanded stretch"), with **Collapse**, which puts the one step back and pauses on it. The step count grows by the stretch's events while it's expanded.
  - **Speed** is steps per second over the steps being played, expanded stretches' events included; instant still goes straight to the end. Condensing never changes the trace: the validator checks all of it, and the result follows the events played (result row *n* is the *n*th row emitted; stepping back over a stretch takes its rows away).
- **Empty-cache toggle:** the **Empty cache** checkbox in the editor toolbar ("start with an empty cache") is on by default, so before each query its tables' and indexes' pages are evicted and every page is first read from disk. Turn it off and rerun to see buffer hits. The choice is remembered in that browser.

## Running statements

- **Editor:** CodeMirror with Postgres syntax. It completes keywords, schemas, tables and columns from the live catalog, so a table created a moment ago completes too. Columns complete after `table.` or `alias.`, and also on their own: the columns of the tables the statement names are offered above keywords, so `WHERE stat` offers `status` first. Suggestions appear as you type, and `Ctrl+Space` opens them. `Tab` or `Enter` accepts the highlighted one; with none open, `Tab` indents the line or selection and `Shift+Tab` dedents. To leave the editor by keyboard, press `Esc`, then `Tab` ([ADR 0030](decisions/0030-editor-tab-and-column-completion.md)). Syntax colors stay neutral, because the accent colors are reserved for their meanings. Long lines wrap to the pane's width. The editor's text is remembered in that browser.
- **Examples ▾** in the editor toolbar opens a menu of the 12 examples ([DATA.md](DATA.md#example-queries-v1); [ADR 0041](decisions/0041-examples-menu.md)), each with its number, title and a sentence or two on what to watch for. Picking one replaces the editor's text with the example: its title and description as comments, then each statement under a comment saying what to watch for and the plan to expect ("Expected plan (189 rows, 177 heap pages):" and the plan's nodes). Cmd/Ctrl+Z brings the previous text back, as the menu's footer says. Nothing runs: the cursor goes to the first statement and the editor gets focus, so Cmd/Ctrl+Enter runs it; a multi-step example is walked one statement at a time, top to bottom. Examples that add an index drop it again at the end, so they can be repeated in any order; the text says its plans are for the sample data as it starts, and that **Reset database** restores it. Keyboard: Enter, Space or ↓ opens the menu on the first example (↑ on the last), ↑ ↓ Home End move, Enter picks, Esc or Tab closes it and returns to the button; a click outside closes it. It uses the neutral surface and text tokens, no accent colors, in both themes.
- `Cmd/Ctrl+Enter` (or **Run**) runs the statement under the cursor; `Shift+Cmd/Ctrl+Enter` (or **Run all**) runs the whole editor in order and stops at the first error.
- **Results pane:** one status line per statement ("SELECT: 3 rows, 2 ms", "CREATE INDEX: done, 18 ms", "UPDATE: 4 rows"), Postgres's notices under it, then the rows of the last statement that returned any. Values appear exactly as Postgres prints them (dates as `2024-02-29`, booleans as `t`/`f`), and NULL as a dimmed *NULL*.
- **Plan pane:** the plan of the last query in the run: each node's heading as in text EXPLAIN, actual vs. estimated rows, shared-buffer hits and reads, and its conditions (Index Cond, Filter, Rows Removed by Filter, …), plus planning time and the pages planning found cached or read (system catalogs, index probes; not part of any node's counts), and execution time. Under it, whether the replay matches Postgres ("✓ Replay matches Postgres · 6 checks", which opens to the list of checks, each with Postgres's number and the replay's), or "✗ Replay doesn’t match Postgres" with the list open and the failed checks in red, or why the query can't be animated yet ("Animation isn’t available yet for Aggregate.", "Animation isn’t available yet for sorts that spill to disk (external merge): this one outgrew work_mem."). A run with no query leaves a note saying so.
- **SELECT:** the plan appears immediately and the animation autoplays (the **Autoplay** checkbox can switch that off; then it loads paused at step 0). While the animation plays, the query's result fills in as rows are emitted, showing the step's rows only, the latest in emerald and scrolled into view; a line above the table counts them ("Rows appear as the animation sends them to the result: 58 of 189 so far.") next to **Skip to end**, which moves the animation to its last step and so reveals the whole result. Stepping back or scrubbing takes rows away again. Result row *n* is the *n*th row the replay emits, and the validator checks they're the same rows in the same order ([ADR 0029](decisions/0029-results-follow-the-player.md)). At the last step the whole result shows, even if the replay emitted fewer rows than Postgres returned (the mismatch banner says so). A query that can't be animated shows its result at once.
- **Other statements:** a status line; the schema browser refreshes; no plan and no animation in v1.
- **SQL errors:** Postgres's message in the results pane, with its DETAIL and HINT, and the line and column it points at; clicking those puts the cursor there.
- **Autovacuum:** after each run (not inside an open transaction), tables over Postgres's autovacuum thresholds are vacuumed and/or analyzed. Each one gets a toast in the bottom-right corner, saying which counter crossed which threshold ("autovacuum: analyzed orders / 5,051 rows changed since the last analyze (threshold 5,050)"). Toasts close after 10 seconds or with ✕. The **Autovacuum** checkbox in the editor toolbar turns the simulator off, to study stale statistics; the choice is remembered in that browser. Run stays disabled until autovacuum and the schema refresh are done.

## Defaults

- Results pane shows up to 1,000 rows plus the total count.
- With the OS "reduce motion" setting on, transitions are instant; stepping still works.
- Supported browsers: current desktop Chrome, Edge, Firefox, Safari.
- Real Postgres terms throughout, each with a glossary tooltip (see **Glossary** below).

## Glossary

Real Postgres terms are marked with a dotted underline in a neutral color: the accent colors keep their meanings, and the term keeps the color of the text around it. The pointer over a term, or keyboard focus on it (Tab), shows a one- or two-sentence plain-language definition next to it. The definition stays while the pointer moves onto it, and Escape hides it. It follows the theme, and with reduced motion it appears without fading in. Screen readers read the definition as the term's description. All definitions live in `src/glossary/glossary.ts` ([ADR 0040](decisions/0040-glossary-tooltips.md)).

- **Marked:**
  - **Plan pane:** node types in headings, EXPLAIN fields (Index Cond, Filter, Rows Removed by Filter, Recheck Cond, Heap Fetches, Index Searches, …), `est.`, buffer `hit` / `read`, and what each replay check compares.
  - **Visualization:** the node line; the zone headings (Index, Shared buffers, Heap); `search`, `leaf` and `marked dead` above the B-tree; buffer `hits` / `reads`; `bitmap`, `all-visible` and `visible`.
  - **Page browser:** `heap page`, `line pointers`, `visible`, `ctid`, `root` / `leaf` / `level N`, `entries` / `downlinks`.
  - **Schema details:** heap pages, planner estimate, B-tree levels, autovacuum, vacuum, analyze, dead rows.
  - **Toolbar:** Autovacuum and Empty cache. A click on a term shows its definition and doesn't toggle the checkbox.
- **Not marked:**
  - **Captions,** which change at every step. The terms they use are marked in the zones beside them.
  - **The B-tree drawing.**
  - **Text repeated on every row.**
