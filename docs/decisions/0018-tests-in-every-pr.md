# 0018: Tests in every PR

- **Status:** Accepted
- **Date:** 2026-10-07

## Context
Claude writes most of the code and Flemming reviews it ([ADR 0015](0015-workflow-and-milestones.md)). A green CI run only means something if the tests cover what the PR changed. Before this decision, the pre-PR step was `npm run check`, which skips the browser tests, and the first M1 PR left its headline behavior, keeping the learner's changes across a restart, without a test.

## Decision
- Every PR adds tests for each behavior it adds or changes: Vitest for database and worker logic, Playwright for what a visitor sees and does.
- A new test is shown to fail when the code it covers is broken on purpose, then pass when the code is restored.
- Before opening a PR, run `npm run verify` (everything CI runs, including Playwright) and check the change by hand in the running app.
- The PR description has a **Testing** section: what the tests cover, what was checked by hand, and what isn't tested yet and why. Gaps are listed, not hidden.

## Consequences
PRs are a little slower to open, and reviews can start from the Testing section. Some behavior can't be tested until a later PR builds the UI to reach it (for example, the outdated-seed banner needs the SQL editor to fake an old seed version). Those gaps are listed in the PR and closed by the PR that makes them testable.

## Alternatives considered
- `npm run check` only, with Playwright left to CI: faster locally, but browser failures surface after the PR is open.
- A coverage percentage gate: easy to measure, but it counts executed lines, not whether behavior is checked.
