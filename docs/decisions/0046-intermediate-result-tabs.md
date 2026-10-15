# 0046: Intermediate-result tabs in the Results pane

- **Status:** Accepted
- **Date:** 2026-10-14

## Context
[ADR 0009](0009-layout-and-run-behavior.md) gave the Results pane a **Final** tab plus "one tab per intermediate result", for v2, and [UX.md](../UX.md#layout) sketches it as `[Final: 12 rows] [Hash: 30] [Sort: 312]`. [ADR 0029](0029-results-follow-the-player.md) made the result follow the player: at a step, the pane shows the rows sent to the result so far. Its rows are Postgres's own, and the validator has checked the replay's rows against them.

v2 plans have nodes that collect rows before passing them on: a Hash builds a table of its whole input before its join probes it, a Materialize stores rows to hand back on every loop, a HashAggregate fills groups, a CTE fills a store. v1's Sort already does this, and the visualization's Sort zone shows at most 6 of its rows. A visitor who wants to see what a node holds, all 10,000 customers in example 16's Hash, has nowhere to look. Postgres doesn't return these rows; only the final result comes back to the client.

## Decision
- **Which nodes get a tab:** each plan node that **holds a set of rows**: Sort, Hash, Materialize, HashAggregate (its groups), a materialized CTE (its store) and an InitPlan (its one value). Nodes that pass rows straight through get none: scans, joins, Limit, GroupAggregate, Subquery Scan, CTE Scan and Result. Their rows go into their parent, or into Final. A bitmap holds row pointers, not rows; it stays in the heap zone's violet line.
- **Tab label:** the node as the plan pane names it, short, with the alias of what it holds and its row count so far: `Hash (c) · 4,812`, `Sort · 37`, `Materialize (b) · 12`, `CTE hawkins · 38`, `HashAggregate · 4 groups`, `InitPlan 1 · 1`. Tabs are violet, the color for intermediate results ([UX.md](../UX.md#color-meanings)), in plan order (depth first), after **Final**.
- **They follow the player**, as Final does. At a step, a tab shows the rows its node holds after that step's events. A Sort's rows are shown in arrival order until `sort.done`, then in sorted order. In a top-N heapsort, the rows kept so far are shown, and a dropped row leaves. A Hash grows row by row while it builds. Stepping back takes rows away again. At the last step, each tab shows everything its node held.
- **Values come from Postgres, never computed by the app.** Each held row carries the ctids of the table rows it was built from, which the trace already names. Its values are read by those ctids with the node's own output expressions (`Output:` in `EXPLAIN VERBOSE`), as the validator reads the final result's. An aggregate's groups are computed by Postgres over each group's rows. While a group is still filling, its tab shows the group's key and how many rows it has so far, counted from the trace. Its aggregate values (`count`, `sum`, `max`) appear once the node has all its input. An InitPlan shows the value Postgres computed.
- **Loops:** a node that runs once per outer row (a Materialize on its first loop, a Sort under a Nested Loop) shows the rows of the current loop, and the label says which ("loop 12 of 38"). A Materialize that reads back its store says so ("read back from memory, loop 7 of 12") and doesn't add the rows twice.
- **Selecting a tab:** Final stays selected unless the visitor picks another. A tab whose rows change at the current step shows a violet dot. Clicking a node with a tab in the plan pane, or the node zone's link ("all 10,000 rows in the Hash tab"), selects its tab. The choice holds for the rest of the run and goes back to Final on the next one.
- **Limits:** up to 1,000 rows shown per tab, with the total, as for Final. Values appear as Postgres prints them.
- **Checked:** at the last step, each tab's row count equals what Postgres reports. For most nodes that is the rows the child passed in (the child's actual rows × loops); this is not the node's own output, since a Sort under a Limit holds more rows than it passes on. For a HashAggregate it is its groups: its actual rows, plus any its HAVING filter removed. The validator adds that check per node. When the replay doesn't match, the tabs show what the replay produced, under the same mismatch banner.
- **v1's Sort gets its tab in M4** (example 10's second query). The visualization's Sort zone stays as it is: it shows what changes at this step, and the tab shows everything the node holds.

## Consequences
- Every intermediate set the animation talks about can be read in full, row by row, and each row's values come from Postgres.
- Reading values by ctid costs a query per node with a tab, after the replay, like the Show internals reads ([ADR 0039](0039-show-internals.md)). Example 16's Hash reads 10,000 rows, the largest set in the examples. A tab caps what it reads at 1,000 rows, and reads a node's later rows only when the visitor scrolls to them.
- A held row built from a join (a Hash over a join, or a Materialize over one) carries a ctid per table. The reading query joins those tables by ctid.
- A volatile output expression (`random()`) could read differently from what Postgres held; the validator's volatile-query note covers it.
- An aggregate value shown only once the node is done means a HashAggregate's tab fills in keys and counts first, then its values all at once. Showing running sums would mean the app computing them, which breaks Principle 1.
- The pane's tab bar can grow long (example 29 has a Hash per join and a HashAggregate: four tabs). Labels stay short, and the bar scrolls sideways if it overflows.

## Alternatives considered
- **A tab for every plan node:** complete, but a scan's tab would only repeat what its parent receives, and a four-table join would get ten tabs.
- **Rows only inside the visualization's node zone:** no new UI, but the zone has room for a handful of rows, not 10,000.
- **Values from the replay's own evaluation** (computing `count` and `sum` in TypeScript): no extra queries, but the app would be the source of numbers it shows, which Principle 1 rules out.
- **Switching to the active node's tab automatically:** shows the right rows without a click, but the pane would jump between tabs during a join and pull the visitor away from Final, which most visitors are watching.
