# logging

Dev fixture for testing build-time log level elimination via `--loglevel`.

## What it does

`app/main.ts` calls every console log level (`debug`, `log`, `info`, `warn`, `error`) before and after a sleep. Deploy with different `--loglevel` values to verify that the expected calls are stripped from the build output.

## Try it

```sh
pnpm install

# Default (deploy defaults to --loglevel=warn): strips debug, log, info
pnpm run deploy

# Keep everything
pnpm run deploy -- --loglevel=debug

# Strip everything except errors
pnpm run deploy -- --loglevel=error

# Dev mode keeps all logs by default
pnpm run dev
```

## What to look for

With `--loglevel=warn` (the deploy default), you should only see `Warn!` and `Error!` in the console output. With `--loglevel=debug`, all five levels appear.

## `@__PURE__` annotation

If you have helper functions that compute values only used in log calls, annotate them with `/* @__PURE__ */` so the minifier can cascade the removal when the log call is stripped:

```ts
const m = /* @__PURE__ */ memoryUsage()
console.log(`heap: ${m.heapUsed}`)
// both statements eliminated at --loglevel=warn
```
