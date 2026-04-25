# @repo/bench-site

Static site and CLIs for tracking mikrojs memory benchmarks. Deployed to
Cloudflare Workers Assets; history lives on the `bench-data` branch.

## Layout

- `src/app.ts` — browser UI (Observable Plot). Reads `data.js` from the same directory.
- `src/update.ts` — CLI that appends a new run to `data.js` (github-action-benchmark format).
- `src/check-regression.ts` — CLI that fails CI if any metric regressed by more than a threshold vs. the last main-branch run on the `bench-data` branch.
- `src/build.ts` — esbuild bundle step producing `dist/{index.html,bench.js,bench.css}`.
- `src/dev.ts` — local dev server; watches source and serves against live or local `data.js`.

## Scripts

```sh
pnpm --filter @repo/bench-site build        # bundle into dist/
pnpm --filter @repo/bench-site dev          # dev server, defaults to live bench-data
pnpm --filter @repo/bench-site typecheck
```

Dev server options:

```sh
pnpm --filter @repo/bench-site dev -- --port 5200
pnpm --filter @repo/bench-site dev -- --data-file /path/to/data.js
pnpm --filter @repo/bench-site dev -- --data-url https://example.com/data.js
```

## CI

The `.github/workflows/memory-bench.yml` workflow runs the memory benchmark on
every push and PR. On main pushes it appends the new run to `data.js` on the
`bench-data` branch, then deploys the site (with the updated `data.js`) to
Cloudflare via `wrangler deploy`. On PRs it runs the regression check against
the latest entry on `bench-data`.
