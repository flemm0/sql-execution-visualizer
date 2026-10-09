# 0023: Save the database once per run, not after every query

- **Status:** Accepted
- **Date:** 2026-10-09

## Context
PGlite saves the database to IndexedDB after every query, reads included, and makes the query wait for the save: about 40 ms per query in the measurements of [ADR 0022](0022-replay-pipeline-placement-and-buffer-counts.md). The replay pipeline will send dozens of small queries per run, so ADR 0022 decided to switch on PGlite's `relaxedDurability`, which starts each save without waiting for it, accepting that "a write made in the last ~40 ms before the tab closes can be lost".

Trying it showed the window is wider than that. In headless Chromium in the cloud container:

- With `relaxedDurability`, 20 `SELECT`s run with **Run all** show their results in about 0.4 s instead of 6.4 s.
- But a write followed by a reload as soon as its result shows was lost **6 times out of 6**. A reload 300 ms later kept it. The app has no way to know when a background save has finished: in relaxed mode, PGlite's `syncToFs()` returns without waiting too.

Looking for the cause also showed where the remaining time went:

- PGlite's `db.query` and `db.exec`, called on the page, ask the worker to save when they finish (`syncToFs`), on top of the save after each message. With `relaxedDurability` that request returns at once; without it, it waits.
- PGlite's `execProtocolRaw` has a `syncToFs: false` option, and ADR 0022 turned down using it because the worker proxy doesn't pass options through. The object the worker hands to the proxy can add the option itself, though.

## Decision
- **The pages' queries don't save.** `db.worker.ts` hands PGlite's worker proxy the database wrapped by `saveWhenAsked` (`src/db/saveWhenAsked.ts`), which adds `syncToFs: false` to the four methods the proxy runs queries with. `relaxedDurability` stays off.
- **The app saves once per run**, at its very end (after the statements, the autovacuum simulator and the catalog reload), by calling `syncToFs()`, which waits until the save is done. **Run** is enabled again only after that, so once it is, the run's changes are saved.
- **Reset database** is saved once, when it's complete, so a reset cut short by a reload leaves the old database rather than half of a new one.
- **Seeding** runs in the worker on the database itself, so each of its queries is saved before the next, as before.
- **Every query the app sends goes through `query()` or `sendQuery()`** (`src/db/query.ts`): the simple query protocol through `execProtocolRaw`, decoded on the main thread, never `db.query` or `db.exec`. They wait until the tab is connected to the worker (`waitReady`) and take PGlite's query lock (`runExclusive`), as `db.query` does.

## Consequences
- 20 `SELECT`s show their results in about 0.4 s instead of 6.4 s, and the run is over (Run enabled again) after about 0.5 s instead of 10.2 s. Reads never wait for a save.
- When Run is enabled again, every change is saved. Closing the tab *during* a run can still lose that run's changes; before, each finished statement was saved.
- A run that only reads still saves once. The save finds nothing changed (the cost is the comparison with what's stored), so it's cheap, and one rule is easier to trust than deciding which runs wrote.
- Code that calls `db.query` or `db.exec` on the page still works and is still correct, but each call waits for a full save again. The tests check that a whole run, including the autovacuum simulator and the catalog reload, saves zero times until asked.
- `saveWhenAsked` depends on which PGlite methods the worker proxy calls. A PGlite upgrade could add another; its tests call all four by name.

## Alternatives considered
- **`relaxedDurability`** (ADR 0022's plan): fastest, and no code of ours, but a change made just before a reload is lost, and nothing can tell when it's safe.
- **Full durability, as before:** safe, but about 40 ms per query; the replay pipeline's dozens of queries per run would take seconds.
- **Saving only after runs that wrote:** saves a cheap comparison on read-only runs, but needs the classifier to be right about every statement (functions can write too).
- **Telling the worker's own save requests apart from the app's** (PGlite's `db.query` asks for a save while it holds the query lock, the app outside it): lets the app keep using `db.query`, but depends on PGlite internals that could change in any release.
