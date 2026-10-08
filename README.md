# SQL Execution Visualizer

Watch PostgreSQL execute your query one step at a time: which index pages it walks, which table pages it reads from disk into memory, which rows pass each condition, and how the result set builds up.

Everything runs in your browser on a real Postgres engine ([PGlite](https://pglite.dev)): no server and no sign-up. Inspired by Markus Winand's [*SQL Performance Explained*](https://sql-performance-explained.com/).

**Status:** early development. See the [roadmap](docs/ROADMAP.md).

## Docs

- [Vision](docs/VISION.md): what this is and who it's for
- [Architecture](docs/ARCHITECTURE.md): how it works
- [UX](docs/UX.md): layout and visual design
- [Seed data and examples](docs/DATA.md)
- [Decision records](docs/decisions/)

## Development

Requires Node.js 20.19+ (CI uses Node 24).

```sh
npm install
npm run dev        # local dev server
npm run check      # lint, unit tests, typecheck, production build
npm run test:e2e   # browser tests (first run: npx playwright install chromium)
npm run verify     # both: everything CI runs; run before opening a PR
```

## License

[MIT](LICENSE)
