---
title: Configuration
description: Complete reference for mikro.config.ts
---

# Configuration

Project configuration lives in `mikro.config.ts` at the root of your project, next to `package.json`.

```ts twoslash
import {defineConfig} from 'mikrojs'

export default defineConfig({
  // options here
})
```

`defineConfig` is a no-op identity function that provides type checking and autocompletion.

## Runtime options

These options are bundled into the deployed app and read by the firmware at boot.

| Option                       | Type                | Default          | Description                                   |
| ---------------------------- | ------------------- | ---------------- | --------------------------------------------- |
| `restartOnUncaughtException` | `boolean`           | `false`          | Restart device on uncaught exception          |
| `restartDelay`               | `number` (ms)       | `0`              | Delay before restart after uncaught exception |
| `stackSize`                  | `number` (bytes)    | firmware default | QuickJS C stack size                          |
| `memReserved`                | `number` (bytes)    | `65536` (64 KB)  | Heap reserved for native subsystems           |
| `wifi.country`               | `WifiCountryCode`   | none             | WiFi regulatory country code                  |
| `wifi.hostname`              | `string`            | `mikrojs-<id>`   | DHCP hostname advertised by the STA interface |
| `logFile`                    | `true \| object`    | off              | Enable on-device file logging                 |
| `logFile.dir`                | `string`            | `'/appfs/logs'`  | Directory the log file lives in               |
| `logFile.maxSize`            | `number \| string`  | `'64k'`          | Rotate when file exceeds this size            |
| `logFile.flush`              | `'line' \| 'error'` | `'error'`        | When to flush buffered writes to flash        |

### `restartOnUncaughtException`

Automatically restart the device when an uncaught exception reaches the top level. Useful for production deployments where you want the device to recover from transient failures. See [Error Handling](/error-handling) for details.

### `restartDelay`

Delay in milliseconds before restarting after an uncaught exception. Only meaningful when `restartOnUncaughtException` is `true`. A small delay (e.g. 500) gives the device breathing room for serial connections before the restart.

### `stackSize`

QuickJS C stack size. Controls how deep call stacks and recursion can go before hitting a stack overflow. The default is set by the firmware and is suitable for most apps. Only increase this if you hit `InternalError: stack overflow` on code that genuinely needs deep recursion.

### `memReserved`

Amount of system heap to keep out of QuickJS's reach, reserved for native subsystems (WiFi, lwIP, TLS, HTTP client, C drivers). At runtime initialization, the QuickJS soft cap is computed as `free_heap_at_init - memReserved`.

- **Lower it** (16-32 KB) if your app doesn't touch the network stack. You'll free up more of the heap for JS and module loading.
- **Keep the default** (64 KB) for anything with WiFi + HTTPS. TLS handshakes need contiguous multi-KB buffers.
- **Don't go below ~8 KB** unless you know exactly what your native side does. If system heap hits 0 while QuickJS still thinks it has budget left, that's a hard crash rather than a catchable JS OOM.

Use `/mem` in the REPL to verify: the **System** line should have a comfortable cushion over the **QuickJS** line. See [Tuning memReserved](/developing-for-microcontrollers#tuning-memreserved) for more guidance.

### `wifi.country`

Two-letter [ISO 3166-1](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) country code for WiFi regulatory domain. Controls which channels and power levels are available. Set this to your country to comply with local regulations and ensure optimal WiFi performance. When unset, ESP-IDF defaults to world safe mode (`"01"`, channels 1-11). The full list of supported codes is defined by the [ESP-IDF regulatory database](https://github.com/espressif/esp-idf/blob/v6.0/components/esp_wifi/regulatory/esp_wifi_regulatory.txt) (168 countries/regions).

### `wifi.hostname`

DHCP hostname advertised by the STA interface. This is what your router shows in its client list. When unset, defaults to `mikrojs-<device-id>` (e.g. `mikrojs-abcdef0123`), where the device ID is a base32-encoded MAC. Must conform to RFC 1123: letters, digits and hyphens only, must not start or end with a hyphen, max 63 characters. Takes effect on the next DHCP lease.

### `logFile`

Persist runtime output to a rotated file on the device filesystem for post-mortem debugging. Captures JS `console.*` output, native `MIK_LOG` calls, and ESP-IDF `ESP_LOG` lines. Each entry is prefixed with an ISO 8601 wall-clock timestamp (when the RTC has been set by SNTP) or `[+SSS.fffs]` relative to boot otherwise.

Set to `true` for sensible defaults, or pass an options object to override individual settings:

```ts
export default defineConfig({
  logFile: true,
})

// or:
export default defineConfig({
  logFile: {
    dir: '/appfs/logs',
    maxSize: '128k',
    flush: 'line',
  },
})
```

Pull the file off the device with [`mikro logs pull`](/cli#mikro-logs).

#### `logFile.dir`

Directory on the device filesystem where the log file is stored. The file itself is always named `log.txt`, rotated as `log.txt.1` once `maxSize` is reached. The directory is created on first boot if it doesn't exist.

#### `logFile.maxSize`

Maximum file size before rotation. Accepts a number of bytes or a string with K/M suffix (e.g. `'64k'`, `'1m'`). At the cap, `log.txt` is renamed to `log.txt.1` (replacing any previous generation) and a fresh `log.txt` is started. Total flash usage is bounded at **2 × maxSize**.

#### `logFile.flush`

When buffered log writes are committed to flash. Tradeoff between forensic fidelity and flash wear:

- `'error'` (default) — buffer everything, flush only on warn/error lines. The post-mortem sweet spot: errors land on flash immediately, normal output rides the stdio buffer.
- `'line'` — flush after every newline. Strongest crash-recovery guarantee, hardest on flash. Use only if you genuinely need every line to survive a hard reset.

::: warning Flash budget
Logging to flash burns write cycles. Rotation caps usage at `2 × maxSize`, but `flush: 'line'` will accelerate wear noticeably under chatty workloads. Default to `'error'` unless you have a specific reason not to.
:::

## Build options {#build}

Build-time options that control how your code is compiled and bundled. These are stripped from the config before deploying to the device. Can also be overridden by CLI flags.

| Option              | Type                                               | Default     | Description                             |
| ------------------- | -------------------------------------------------- | ----------- | --------------------------------------- |
| `build.bundle`      | `boolean`                                          | `false`     | Bundle into a single module via esbuild |
| `build.minifier`    | `'esbuild' \| 'terser' \| 'swc'`                   | `'esbuild'` | Which minifier to use                   |
| `build.minifyLevel` | `'default' \| 'max'`                               | `'default'` | Minification aggressiveness             |
| `build.logLevel`    | `'none' \| 'error' \| 'warn' \| 'info' \| 'debug'` | `'debug'`   | Build-time log level threshold          |

### `build.bundle` {#buildbundle}

Bundle user code into a single module via esbuild, with tree-shaking. Firmware builtins (`mikrojs/*` and `@mikrojs/*` packages with native code) stay external.

Bundling reduces QuickJS per-module overhead and strips unused code paths, at the cost of less informative stack traces.

### `build.minifier` {#buildminifier}

Which minifier to use. `esbuild` is always available. `terser` requires the `terser` package to be installed; `swc` requires `@swc/core`.

### `build.minifyLevel` {#buildminifylevel}

Minification aggressiveness. `'default'` uses safe transforms only. `'max'` enables unsafe transforms (multiple compress passes, toplevel mangling, pure_getters, unsafe_arrows, unsafe_math, unsafe_methods) for the smallest possible output.

### `build.logLevel` {#buildloglevel}

Build-time log level. Console methods below this threshold are eliminated as dead code by the minifier. Levels from most to least verbose: `debug` > `info` > `warn` > `error` > `none`.

The CLI `--loglevel` flag overrides this setting.

::: tip Cascading removal with `@__PURE__`
If you have helper functions that compute values only used in log calls, annotate them with `/* @__PURE__ */` so the minifier can cascade the removal:

```ts
const m = /* @__PURE__ */ memoryUsage()
console.log(`[mem] heap: ${m.heapUsed}`)
// both statements eliminated at logLevel: 'warn'
```

:::

::: warning Increasing log verbosity may cause OOM
Setting a higher log level (e.g. `debug`) keeps more console calls in the bundle. Each call site adds string formatting, template literal evaluation, and argument allocation at runtime. On memory-constrained devices this extra work can push the QuickJS heap past its limit and cause `InternalError: out of memory`. If you need verbose logging on a tight device, add it incrementally and monitor heap usage with `/mem` in the REPL.
:::

## Simulator options {#sim}

Simulator-specific options. These are stripped from the config before deploying to a real device.

| Option         | Type               | Default           | Description                       |
| -------------- | ------------------ | ----------------- | --------------------------------- |
| `sim.memLimit` | `number \| string` | `'300k'`          | QuickJS heap memory limit         |
| `sim.fsLimit`  | `number \| string` | `'1m'`            | Virtual filesystem size limit     |
| `sim.fsRoot`   | `string`           | `'.mikro/sim-fs'` | Filesystem sandbox root directory |

All size options accept a number of bytes or a string with K/M suffix (e.g. `'300k'`, `'1m'`).

## Full example

```ts twoslash
import {defineConfig} from 'mikrojs'

export default defineConfig({
  restartOnUncaughtException: true,
  restartDelay: 500,
  memReserved: 32 * 1024,
  wifi: {
    country: 'NO', // Norway
    hostname: 'living-room-sensor',
  },

  logFile: true,

  build: {
    bundle: true,
    minifier: 'esbuild',
    minifyLevel: 'max',
    logLevel: 'warn',
  },

  sim: {
    memLimit: '512k',
    fsLimit: '2m',
  },
})
```
