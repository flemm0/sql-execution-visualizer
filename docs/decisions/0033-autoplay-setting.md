# 0033: The autoplay setting

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
[ADR 0009](0009-layout-and-run-behavior.md) says SELECTs autoplay and a setting can switch that off; until now every run autoplayed ([ADR 0027](0027-player-steps-and-state.md), [ADR 0029](0029-results-follow-the-player.md)). A learner who wants to read the plan first, or step through from the start, had to press pause as soon as a run finished.

## Decision
- **An Autoplay checkbox in the player controls**, next to Speed: both say how an animation plays, and it sits where the animation is. On by default; remembered in that browser (`player-autoplay` in `localStorage`), like the speed.
- **Off, each run loads paused at step 0**, even at instant speed (which with autoplay on starts at the end). The results pane then shows 0 rows so far, with **Skip to end**, as it does at step 0 while playing.
- **Changing it applies from the next run.** What is loaded now keeps playing, or stays paused.
- Where a trace starts is a pure function, `startOfTrace(steps, speed, autoplay)` in `playback.ts`, so it's unit-tested without a browser.

## Consequences
- The checkbox appears only once there is an animation, so the very first run of a visit always autoplays. Every later visit remembers the choice.

## Alternatives considered
- **In the editor toolbar**, with Autovacuum and Empty cache: there from the first visit, but those two change what a run does to the database. Autoplay only changes playback.
- **Applying it at once** (unchecking pauses, checking plays): that duplicates the play/pause button, and a setting that also acts would be surprising.
