# 0012: Public repo on GitHub Pages, MIT license

- **Status:** Accepted
- **Date:** 2026-10-05

## Context
Hosting must be free. The app is static files ([0004](0004-pglite-plus-replay-engine.md)). On GitHub's free plan, Pages only serves public repositories.

## Decision
- Public repo `flemm0/sql-execution-visualizer`, MIT license.
- Served at `https://flemm0.github.io/sql-execution-visualizer/`.
- Deployed by GitHub Actions on every push to `main`.

## Consequences
Free, simple, and open source. GitHub Pages cannot set custom HTTP headers; PGlite should not need any (M0 verifies). Renaming the repo would change the URL.

## Alternatives considered
- Private repo + Cloudflare Pages: free, allows custom headers. This is the fallback if headers turn out to matter.
- Netlify or Vercel free tiers.
