# 0029: The result fills in from the player's step; App owns the one player

- **Status:** Accepted
- **Date:** 2026-10-11

## Context
[UX.md](../UX.md#running-statements) wants a SELECT's result to fill in as the animation emits rows, with **Skip to end** to reveal it all. Until now the results pane showed the whole result at once, and the player lived inside the visualization pane, keyed by run ([ADR 0027](0027-player-steps-and-state.md)), so no other pane knew which step was showing.

The rows in the results pane are Postgres's own (the first 1,000, with the total). The trace's `row.emit` events number the rows they send to the result (`resultIndex`, from 0), and the validator checks that the replay's rows have the same values in the same order as Postgres's ([ADR 0024](0024-seq-scan-trace-per-page.md)).

## Decision
- **App owns the one player** (`usePlayer()`), and passes it to the visualization. Each run loads its trace into it (`player.load(steps)`), which starts at step 0 and autoplays, as before. The results pane reads the same position.
- **At a step, the results pane shows the first *n* rows of the real result**, where *n* is the number of `row.emit` events to the result so far (`resultRowsAt`). The latest is emerald and scrolled into view.
- **At the last step the whole result shows**, even when the replay emitted a different number of rows (a volatile query): the result is Postgres's, and the mismatch banner already warns that the animation may not match.
- **Skip to end** moves the player to its last step, so the visualization and the result always agree on the step.
- A query with nothing to animate (unsupported or failed replay) shows its result at once.

## Consequences
- Truthful: the rows shown are Postgres's, and which of them have "arrived" comes from a trace the validator has checked row by row.
- Counting the emitted rows rescans the trace up to the step on every render: about a millisecond at the end of a 200,000-event trace, cheap next to `stateAt` ([ADR 0027](0027-player-steps-and-state.md)).
- A big result (`SELECT * FROM order_items`, 200,582 rows) fills in one row per step; **Skip to end** (or instant speed) is the way through until M3's condensing.
- v2's intermediate-result tabs can follow the same player.

## Alternatives considered
- **The visualization reports its step to App** (a callback from an effect): leaves the player where it was, but keeps the step in two places that can drift, and Skip to end would need a way back into the visualization.
- **Skip to end only reveals the rows**, leaving the animation where it is: the result would then show rows the animation hasn't emitted yet.
- **Reading rows by `ctid` as they're emitted:** the replay already compared them with the result; reading them again would only repeat it.
