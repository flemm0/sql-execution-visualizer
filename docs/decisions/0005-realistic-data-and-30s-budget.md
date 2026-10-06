# 0005: Realistic table sizes, with animations condensed to a ~30 s budget

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
The planner only picks index scans when tables span many pages, but a row-by-row animation over thousands of rows is unwatchable (a 10,000-row Seq Scan at 10 steps/s takes ~17 minutes). Flemming's requirement: animations must not be too long.

## Decision
- Use realistic sizes, 12 to ~200,000 rows ([DATA.md](../DATA.md)), including one large table so some B-tree is 3 levels deep. Never force plans with `enable_*` settings.
- At normal speed every animation finishes in about **30 seconds**. The player plays early pages row by row, then condenses repetitive runs of real events into **stretches** ("page 37: 150 rows checked, 2 matched"). Matching rows still flash individually.
- Every stretch has exact counts and can be expanded to full step-by-step detail, computed lazily.

## Consequences
Plans are genuine and animations stay short. Condensing groups real events; it never invents or drops them. The condensing pass and lazy expansion add player complexity.

## Alternatives considered
- Tiny tables with forced index use: short, but fake plans.
- Smart speed-up only: same detail throughout, still too long on big scans.
- A hard step cap with no animation beyond it: loses the most instructive cases.
