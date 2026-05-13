# logging

Dev fixture for two related but separate concerns:

1. **Build-time log level elimination** via `--loglevel` (strips `console.*` calls below the threshold).
2. **On-device file logging** via the `logFile:` block in `mikro.config.ts` (captures runtime output into a rotated log file for post-mortem inspection).

## What it does

`app/main.ts` calls every console log level (`debug`, `log`, `info`, `warn`, `error`) before and after a sleep. Deploy with different `--loglevel` values to verify that the expected calls are stripped from the build output.

`mikro.config.ts` enables file logging with an 8 KB cap and the default `flush: 'error'` policy: lines are buffered in RAM and committed to flash whenever an error/warn line lands — the post-mortem sweet spot, strong forensic signal with minimal flash wear. Logs land at `/appfs/logs/log.txt` (default).

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

## Pulling the log file

After deploying and exercising the app, pull the on-device log to inspect what was captured:

```sh
pnpm run deploy
# … exercise the app …

# Stream to stdout (older rotated generation first, then current — chronological):
mikro logs pull

# Or pull both files into a directory for archiving:
mikro logs pull ./tmp-logs
ls ./tmp-logs   # log.txt, log.txt.1 if a rotation happened
```

The flushed lines should include each call that survived the `--loglevel` filter, prefixed with either an ISO 8601 wall-clock timestamp (when SNTP has set the RTC) or `[+SSS.fffs]` boot-relative time.

## `@__PURE__` annotation

If you have helper functions that compute values only used in log calls, annotate them with `/* @__PURE__ */` so the minifier can cascade the removal when the log call is stripped:

```ts
const m = /* @__PURE__ */ memoryUsage()
console.log(`heap: ${m.heapUsed}`)
// both statements eliminated at --loglevel=warn
```
