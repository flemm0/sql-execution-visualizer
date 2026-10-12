# 0034: Exit criteria are tests, run against the live site after every deploy

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
[ROADMAP.md](../ROADMAP.md) counts a milestone as done when its exit criteria hold on the live site. Until now that was checked by hand, if at all. CI tested pull requests against a local build of the same code. That build is close to what GitHub Pages serves, but differences in hosting (the base path, headers, caching, a deploy that failed or never ran) could only show up live.

## Decision
- **`e2e/exit-criteria.spec.ts` states each milestone's exit criteria as Playwright tests**, written as a visitor would check them. M2's: examples 1, 2, 4 and 11 each say "✓ Replay matches Postgres", show no mismatch banner, play to the end with the caption naming the rows sent, and show the whole result.
- **It runs in CI on every PR**, against the local build, like the other Playwright tests.
- **The Live check workflow runs it against the live site** (`LIVE_URL`, which points Playwright at that URL and starts no local server). It runs after every successful deploy (with the deployed commit's tests), on demand, and on PRs that change the workflow.
- A milestone's status line in ROADMAP.md says "done" once its criteria pass there.

## Consequences
- A deploy that breaks a finished milestone's criteria turns the Live check red, even when the PR's own CI was green.
- Each run seeds the sample data in a fresh browser, about a second per test, on the live site as a first-time visitor would.
- GitHub Pages can serve the previous build for a few minutes after a deploy, so a run can test the old version. It catches that on the next deploy, or a manual re-run.
- Later milestones add their criteria to the same spec. A PR that adds criteria for features not deployed yet passes CI but fails the Live check until it's merged and deployed. That's correct, since the milestone isn't live yet.

## Alternatives considered
- **Checking by hand after each milestone:** easy to skip, and it leaves no record.
- **A smoke test in the deploy workflow itself:** the deploy job would need Node and Playwright set up. A separate workflow keeps the deploy fast, and it can be run on its own.
