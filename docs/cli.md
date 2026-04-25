---
title: CLI Reference
description: Complete reference for the mikro command-line tool
---

# CLI Reference

The `mikro` CLI is the main tool for building, deploying, and managing Mikro.js projects.

## mikro dev

Start development mode with live reload. Builds your TypeScript, deploys it to the device over serial, and watches for changes. Every time you save a file, the new code is sent to the device within seconds.

```sh
mikro dev [ENTRY]
```

| Option             | Description                                                           |
| ------------------ | --------------------------------------------------------------------- |
| `ENTRY`            | Entry file (default: `main` field in package.json)                    |
| `-p, --port PORT`  | Serial port (auto-detected if omitted)                                |
| `--env FILE`       | Extra `.env` file, layered on top of auto-discovery                   |
| `--secrets FILE`   | Extra secrets file, layered on top (entries marked secret)            |
| `--no-env-file`    | Skip auto-loading of `.env` and `.env.development`                    |
| `--force-deploy`   | Force full deploy, ignoring cached checksums                          |
| `--no-minify`      | Skip minification                                                     |
| `--no-bytecode`    | Skip bytecode compilation                                             |
| `--loglevel LEVEL` | Log level: `none`, `error`, `warn`, `info`, `debug`. Default: `debug` |
| `--json`           | Output as JSON                                                        |

See [Build options](#build-options) for details on `--no-minify`, `--loglevel`, and other build flags.

To run on the host simulator instead of a device, use [`mikro sim dev`](#mikro-sim).

## mikro deploy

One-shot deploy to a connected device. This is treated as a production deployment: `MIKRO_ENV` is set to `"production"` and `--loglevel` defaults to `warn` (stripping `console.debug`, `console.log`, and `console.info` calls from the build).

```sh
mikro deploy [ENTRY]
```

| Option             | Description                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `ENTRY`            | Entry file (default: `main` field in package.json)                                                               |
| `-p, --port PORT`  | Serial port (auto-detected if omitted)                                                                           |
| `--env FILE`       | Extra `.env` file, layered on top of auto-discovery                                                              |
| `--secrets FILE`   | Extra secrets file, layered on top (entries marked secret)                                                       |
| `--no-env-file`    | Skip auto-loading of `.env` and `.env.production`                                                                |
| `--console`        | Attach console after deploy and restart device                                                                   |
| `-e, --erase`      | Erase current app before uploading                                                                               |
| `--recover`        | Reset into safe mode before deploying. See [Troubleshooting](/troubleshooting#recovering-a-crash-looping-device) |
| `--no-restart`     | Do not restart device after deploy                                                                               |
| `--no-minify`      | Skip minification                                                                                                |
| `--no-bytecode`    | Skip bytecode compilation                                                                                        |
| `--loglevel LEVEL` | Log level: `none`, `error`, `warn`, `info`, `debug`. Default: `warn`                                             |
| `--json`           | Output as JSON                                                                                                   |

See [Build options](#build-options) for details on `--no-minify`, `--loglevel`, and other build flags.

## mikro build

Build your app without deploying. Produces a build directory with bundled and optionally bytecode-compiled output.

```sh
mikro build [ENTRY] [OUTDIR]
```

| Option             | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `ENTRY`            | Entry file (default: `main` field in package.json)                   |
| `OUTDIR`           | Output directory (default: `build`)                                  |
| `--no-minify`      | Skip minification                                                    |
| `--no-bytecode`    | Skip bytecode compilation                                            |
| `--loglevel LEVEL` | Log level: `none`, `error`, `warn`, `info`, `debug`. Default: `warn` |
| `--json`           | Output as JSON                                                       |

See [Build options](#build-options) for details on `--no-minify`, `--loglevel`, and other build flags.

## mikro flash

Flash the Mikro.js runtime firmware to a device. You only need to do this once per board, or when updating Mikro.js.

```sh
mikro flash
```

| Option            | Description                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| `-p, --port PORT` | Serial port (auto-detected if omitted)                                            |
| `--target CHIP`   | Target chip (e.g. `esp32c6`). Auto-detected if omitted                            |
| `--board BOARD`   | Board name. Discovered from `package.json` if omitted                             |
| `--build-dir DIR` | Path to a local ESP-IDF build directory. If omitted, downloads pre-built firmware |
| `--release REF`   | Firmware release tag (e.g. `v0.2.0`) or git commit SHA                            |
| `--baud BAUD`     | Baud rate for flashing (default: `460800`)                                        |
| `-y, --yes`       | Skip confirmation prompt                                                          |

::: tip
`--build-dir` and `--release` are mutually exclusive. Use `--build-dir` if you built firmware from source; use `--release` to pin a specific version.
:::

## mikro list

List connected devices.

```sh
mikro list
```

| Option   | Description    |
| -------- | -------------- |
| `--json` | Output as JSON |

## mikro console

Connect to the device's serial console. Shows runtime output and provides a REPL for interactive evaluation.

```sh
mikro console
```

| Option            | Description                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --port PORT` | Serial port (auto-detected if omitted)                                                                                                             |
| `--raw`           | Plain serial passthrough (no protocol framing)                                                                                                     |
| `--hex`           | Show raw hex bytes                                                                                                                                 |
| `--recover`       | Reset into safe mode before connecting (inspect a crash-looping device). See [Troubleshooting](/troubleshooting#recovering-a-crash-looping-device) |

## mikro tail

Stream console output from the device without an interactive REPL. Useful for monitoring a running app in the background or piping output to other tools.

```sh
mikro tail
```

| Option            | Description                            |
| ----------------- | -------------------------------------- |
| `-p, --port PORT` | Serial port (auto-detected if omitted) |
| `-r, --restart`   | Restart the device first               |

## mikro test

Run on-device tests. Discovers `*.test.ts` files, deploys them, and reports structured results. Each file runs in a fresh runtime with a full heap, so tests are isolated from each other.

```sh
mikro test [PATTERN]
```

| Option                    | Description                                                 |
| ------------------------- | ----------------------------------------------------------- |
| `PATTERN`                 | Glob pattern to filter test files (default: `**/*.test.ts`) |
| `-p, --port PORT`         | Serial port (auto-detected if omitted)                      |
| `--env FILE`              | Extra `.env` file, layered on top of auto-discovery         |
| `--secrets FILE`          | Extra secrets file, layered on top (entries marked secret)  |
| `--no-env-file`           | Skip auto-loading of `.env` and `.env.test`                 |
| `--no-minify`             | Skip minification                                           |
| `--no-bytecode`           | Skip bytecode compilation                                   |
| `-t, --timeout MS`        | Per-file timeout in ms (default: `60000`)                   |
| `--update-heap-baselines` | Overwrite committed per-file heap-baseline snapshots        |
| `--diagnostics`           | Show per-test heap progress and supervisor announcements    |
| `-y, --yes`               | Skip confirmation prompt                                    |
| `--json`                  | Output as JSON                                              |

See [Build options](#build-options) for details on `--no-minify` and other build flags.

```sh
# Run all tests
mikro test

# Run a specific test file
mikro test 'test/smoke.test.ts'

# Run with env vars
mikro test --env .env --secrets .env.secrets
```

Test files import from `mikrojs/test`:

```ts
import {describe, test, assert} from 'mikrojs/test'

describe('my feature', () => {
  test('works', () => {
    assert.equal(1 + 1, 2)
  })
})
```

The environment variable `MIKRO_ENV` is automatically set to `"test"` during test runs.

::: tip
`mikro test` overwrites whatever app is currently on the device with the test manifest. The confirmation prompt exists so you don't do that by accident. Pass `-y` in CI or scripted runs when you know what you're doing.
:::

To run tests in the host simulator, use [`mikro sim test`](#mikro-sim).

## mikro env

Manage environment variables stored on the device. Variables persist across reboots and are accessible via [`mikrojs/env`](/api/env) or `import.meta.env` in your code.

### mikro env list

List all environment variables on the device.

```sh
mikro env list
```

| Option            | Description                            |
| ----------------- | -------------------------------------- |
| `-p, --port PORT` | Serial port (auto-detected if omitted) |
| `--json`          | Output as JSON                         |

### mikro env set

Set an environment variable on the device.

```sh
mikro env set KEY [VALUE]
```

| Option            | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `KEY`             | Variable name (max 15 characters)                             |
| `VALUE`           | Variable value. If omitted with `--secret`, prompts for input |
| `-p, --port PORT` | Serial port (auto-detected if omitted)                        |
| `--secret`        | Mark as a secret (write-only, never displayed)                |

```sh
# Set a plain variable
mikro env set WIFI_SSID MyNetwork

# Set a secret (prompts for value)
mikro env set API_KEY --secret
```

### mikro env delete

Delete an environment variable from the device.

```sh
mikro env delete KEY
```

| Option            | Description                            |
| ----------------- | -------------------------------------- |
| `KEY`             | Variable name to delete                |
| `-p, --port PORT` | Serial port (auto-detected if omitted) |

## mikro clean

Remove the deployed app from the device. The device restarts and boots into the REPL with no app.

```sh
mikro clean
```

| Option            | Description                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `-p, --port PORT` | Serial port (auto-detected if omitted)                                                                          |
| `--full`          | Remove all files and environment variables, not just the deployed app                                           |
| `--recover`       | Reset into safe mode before cleaning. See [Troubleshooting](/troubleshooting#recovering-a-crash-looping-device) |
| `-y, --yes`       | Skip confirmation prompt                                                                                        |

To clean simulator state, use [`mikro sim clean`](#mikro-sim) or [`mikro sim reset`](#mikro-sim).

With `--full`, all user-created files and environment variables are also removed. This requires confirmation (skip with `-y`).

## mikro erase

Erase all flash on the device, performing a full factory reset. This removes firmware, application code, and all stored data.

```sh
mikro erase
```

| Option            | Description                            |
| ----------------- | -------------------------------------- |
| `-p, --port PORT` | Serial port (auto-detected if omitted) |
| `--baud BAUD`     | Baud rate (default: `460800`)          |
| `-y, --yes`       | Skip confirmation prompt               |

::: danger
This erases everything on the device. You will need to re-flash firmware and re-deploy your app afterwards.
:::

## mikro sim

Run your code in the host simulator instead of on a real device. The simulator boots the same QuickJS runtime as a board would, talks the same protocol, and persists files and environment variables under `.mikro/sim-fs/` and `.mikro/nvs.json`.

Only one sim process can run at a time per project. Long-lived commands (`sim dev`, `sim repl`) kill any predecessor on start. One-shot commands (`sim deploy`, `sim test`, `sim env`, `sim profile`, `sim clean`, `sim reset`) refuse to run while a sim is already alive.

Hardware builtins are stubbed; see [Host simulator](/developing-for-microcontrollers#host-simulator) for details. Override the stubs by writing your own `sim/<builtin>.stub.ts` files (use `mikro sim scaffold` to generate starting points). Simulator memory and filesystem limits are configured in [`mikro.config.ts`](/config#sim).

### mikro sim dev

Watch + build + deploy + REPL against the simulator. The sim equivalent of `mikro dev`.

```sh
mikro sim dev [ENTRY]
```

| Option           | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `ENTRY`          | Entry file (default: `main` field in package.json)         |
| `--env FILE`     | Extra `.env` file, layered on top of auto-discovery        |
| `--secrets FILE` | Extra secrets file, layered on top (entries marked secret) |
| `--no-env-file`  | Skip auto-loading of `.env` and `.env.simulator`           |
| `--no-minify`    | Skip minification                                          |
| `--no-bytecode`  | Skip bytecode compilation                                  |

### mikro sim deploy

One-shot build + deploy to the simulator (no watch). The sim equivalent of `mikro deploy`.

```sh
mikro sim deploy [ENTRY]
```

| Option           | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `ENTRY`          | Entry file (default: `main` field in package.json)         |
| `--env FILE`     | Extra `.env` file, layered on top of auto-discovery        |
| `--secrets FILE` | Extra secrets file, layered on top (entries marked secret) |
| `--no-env-file`  | Skip auto-loading of `.env` and `.env.simulator`           |
| `-e, --erase`    | Erase current app before uploading                         |
| `--no-restart`   | Do not restart sim after deploy                            |
| `--no-minify`    | Skip minification                                          |
| `--no-bytecode`  | Skip bytecode compilation                                  |
| `--json`         | Output as JSON                                             |

### mikro sim repl

Open an interactive REPL session on a fresh sim process. The sim equivalent of `mikro console`.

```sh
mikro sim repl
```

### mikro sim test

Discover and run `*.test.ts` files in the simulator. The sim equivalent of `mikro test`.

```sh
mikro sim test [PATTERN]
```

| Option                    | Description                                                 |
| ------------------------- | ----------------------------------------------------------- |
| `PATTERN`                 | Glob pattern to filter test files (default: `**/*.test.ts`) |
| `--env FILE`              | Extra `.env` file, layered on top of auto-discovery         |
| `--secrets FILE`          | Extra secrets file, layered on top (entries marked secret)  |
| `--no-env-file`           | Skip auto-loading of `.env` and `.env.simulator`            |
| `--no-minify`             | Skip minification                                           |
| `--no-bytecode`           | Skip bytecode compilation                                   |
| `-t, --timeout MS`        | Per-file timeout in ms (default: `60000`)                   |
| `--update-heap-baselines` | Overwrite committed per-file heap-baseline snapshots        |
| `--diagnostics`           | Show per-test heap progress and supervisor announcements    |
| `--json`                  | Output as JSON                                              |

### mikro sim env

Manage simulator environment variables. The sim equivalent of `mikro env`.

```sh
mikro sim env list
mikro sim env get KEY
mikro sim env set KEY VALUE [--secret]
mikro sim env delete KEY
```

### mikro sim clean

Remove the deployed app from the simulator (`sim-fs/app/`), leaving environment variables intact.

```sh
mikro sim clean
```

### mikro sim reset

Erase the entire simulator state: filesystem and environment variables.

```sh
mikro sim reset [-y]
```

| Option      | Description              |
| ----------- | ------------------------ |
| `-y, --yes` | Skip confirmation prompt |

### mikro sim profile

Run your app in the simulator and report per-module QuickJS heap usage, so you can see which imports are fat and which are cheap before deploying. Useful for debugging `InternalError: out of memory` failures where the cold-start module load is the suspect.

```sh
mikro sim profile [ENTRY]
```

| Option               | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `ENTRY`              | Entry file (default: `main` field in package.json)         |
| `--mem-limit BYTES`  | QuickJS heap ceiling for the profile run (default: `32M`)  |
| `--memory-budget KB` | Highlight rows against an explicit budget in KB            |
| `--chip NAME`        | Preset budget for a chip (e.g. `esp32c6`, `esp32s3`)       |
| `--top N`            | Show only the N largest modules                            |
| `--sort KEY`         | Sort by `size` (default) or `order` (load order)           |
| `--min-bytes N`      | Hide modules smaller than N bytes                          |
| `--include-native`   | Include `native:*` runtime modules (excluded by default)   |
| `--include-builtins` | Include `mikrojs/*` built-in modules (excluded by default) |
| `--only-native`      | Show only `native:*` modules                               |
| `--only-builtins`    | Show only `mikrojs/*` built-ins                            |
| `--json`             | Output as JSON                                             |
| `--env FILE`         | Extra `.env` file, layered on top of auto-discovery        |
| `--no-env-file`      | Skip auto-loading of `.env` and `.env.development`         |

By default, `native:*` runtime modules and `mikrojs/*` built-ins are hidden so you see only your own code's heap cost. Use `--include-native` / `--include-builtins` to add them back, or `--only-native` / `--only-builtins` for a focused view of just those categories.

The `--mem-limit` is intentionally high (default `32M`) so the measurement run doesn't OOM. The profile output shows whether the app fits in the actual device budget.

### mikro sim scaffold

Generate starting `sim/<builtin>.stub.ts` files in the project's `sim/` directory. Use `--overwrite` to replace existing stubs.

```sh
mikro sim scaffold [--overwrite]
```

## Build options {#build-options}

Commands that build your code (`dev`, `deploy`, `build`, `test`, and their `sim` equivalents) share these options:

- `--no-minify` disables minification. Useful for debugging; the output is larger but more readable in stack traces.
- `--minifier MINIFIER` selects the minifier: `esbuild` (default), `terser`, or `swc`. Can also be set via [`build.minifier`](/config#buildminifier).
- `--minify-level LEVEL` sets minification aggressiveness: `default` or `max`. Can also be set via [`build.minifyLevel`](/config#buildminifylevel).
- `--no-bytecode` skips compiling JavaScript to QuickJS bytecode. The device will parse JavaScript source at runtime, which uses more memory and is slower to start.
- `--loglevel LEVEL` sets the build-time log level. Console calls below the threshold are eliminated as dead code by the minifier. Levels from most to least verbose: `debug` > `info` > `warn` > `error` > `none`. `deploy` and `build` default to `warn`; `dev` defaults to `debug`. See [`build.logLevel`](/config#buildloglevel) for details.
