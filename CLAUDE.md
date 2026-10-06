# SQL Execution Visualizer

A browser-only sandbox that animates what PostgreSQL does when it runs a query: index pages walked, heap pages read into shared buffers, rows filtered and emitted. Real Postgres (PGlite) runs in a Web Worker; a replay engine reconstructs the step order over real pages.

## Docs

The design lives in `docs/`; read the relevant file before working in its area.

- `docs/VISION.md`: goals, audience, principles, non-goals. Read before proposing features or scope changes.
- `docs/ARCHITECTURE.md`: worker pipeline, replay engine, trace format, validator, persistence. Read before touching `src/db/`, replay, or player code.
- `docs/UX.md`: layout, color meanings, visualization, playback, run behavior. Read before UI work.
- `docs/DATA.md`: seed schema, distributions, starting indexes, example queries. Read before changing seed data or examples.
- `docs/ROADMAP.md`: milestones and exit criteria. Read to know what is in scope now.
- `docs/decisions/`: one record per decision, with the reason and alternatives. Read before reversing a decision.

## Working agreements

- **Truthful:** everything the UI shows (plans, page numbers, `ctid`s, keys, counts, cache hits and reads) comes from Postgres. The replay engine only reconstructs order, and the validator checks it. When something can't be validated, the UI says so.
- **Docs move with the design:** a PR that changes behavior or design updates the matching doc in the same PR. A new or reversed decision gets a record in `docs/decisions/` (copy `0000-template.md`; mark the old one superseded).
- **One branch and PR per feature.** Flemming reviews and merges; merging to `main` deploys to GitHub Pages. Run `npm run check` before opening a PR.
- **Readable TypeScript:** Flemming is new to TypeScript. Write conventional, plainly typed code, and explain any non-obvious TypeScript or React pattern in the PR description.
