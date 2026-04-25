---
title: Developing for Microcontrollers
description: Practical tips for writing TypeScript on ESP32
---

# Developing for Microcontrollers

Writing TypeScript for an ESP32 is different from writing it for Node.js or a browser. This page covers the constraints you'll encounter and how to work within them.

## Memory

A typical ESP32 has 320-512KB of RAM. After the runtime starts, you'll have around 200-300KB free. That's plenty for most applications, but it's not infinite. Some boards include PSRAM (2-8MB of external RAM), which gives you a lot more to work with.

### Check your usage

Run `/mem` in the REPL to see where you stand:

```
Available: 239.3 KB

Usage:
  QuickJS:  78.4 / 317.7 KB used   (25%)
  System:  118.4 / 362.9 KB used   (33%, peak 33%)
  Reserved: 8.0 KB (memReserved for native subsystems)
```

**Available** is the number you care about most: how much you can still use. **System peak** shows the highest usage since boot, which helps catch transient spikes you might otherwise miss.

### What uses memory

| What                          | Typical cost         |
| ----------------------------- | -------------------- |
| Runtime startup               | ~75-80 KB (fixed)    |
| Each imported module          | A few KB each        |
| WiFi connection               | ~40 KB               |
| HTTPS request (TLS handshake) | ~40-50 KB on top     |
| Your app code                 | Proportional to size |

WiFi + HTTPS is the biggest consumer. A simple blinky barely makes a dent, but a WiFi app doing HTTPS might leave you with ~100KB free.

### Practical tips

- **Connect to WiFi once** and stay connected. Don't reconnect repeatedly.
- **Use HTTP for local endpoints** if memory is tight. TLS is expensive.
- **Build strings with arrays.** Concatenating in a loop creates a new string each time. Build an array and `.join()` once.
- **Use dynamic imports** to load modules only when needed:

```ts
if (sensorConnected) {
  const {readSensor} = await import('./sensor.js')
  readSensor()
}
```

### Unload modules you're done with

For apps that run in discrete phases (e.g. sense, then send, then sleep), you can reclaim memory by evicting a phase's modules once it's over. `import.meta.unload(specifier)` frees the module record plus any transitive dependency whose only importer was the unloaded module:

```ts twoslash
// @noErrors
declare const input: unknown
// ---cut---
const result = await (async () => {
  const {runPhase} = await import('./phases/modem.js')
  return runPhase(input)
})()

const freed = await import.meta.unload('./phases/modem.js')
console.log('freed %d modules', freed)
```

On a real app this can reclaim tens of KB: a modem phase spanning 7 modules reclaimed ~66 KB in one measured case.

Caveats:

- **Imports must go out of scope first.** A `const {fn} = await import(...)` binding at the top of a function pins the module's exported closures, and closures pin the module's lexical environment. If the binding outlives the `unload()` call, almost nothing is reclaimed. Wrap the import + call in an async IIAE (as above) so the binding dies before `unload()` runs. Return values must also be plain data (numbers, strings, plain objects/arrays); returning a closure or a class instance with methods smuggles the module scope back out.
- **Incompatible with `bundle: true`.** Bundling rewrites source specifiers to chunk names (`./phases/modem.js` becomes `modem-ABC123.js`), so the `unload()` string no longer matches a loaded module and silently frees nothing. Projects that rely on unloading need `bundle: false`.
- **Builtins can't be unloaded.** `mikrojs/*` and `@mikrojs/*` modules are anchored; calls targeting them are no-ops.
- **Use-after-unload is undefined behaviour.** If you call into an unloaded module through a surviving reference (a leftover callback, a timer, a stored object), anything can happen. Treat `unload()` as a hard boundary: after the call, the phase is gone.
- **Only worthwhile for sizeable module trees.** A one- or two-module phase reclaims very little; the technique pays off when a phase pulls in a large tree you don't need again.

If none of those apply, stick with dynamic imports and let refcounting reclaim values as they go out of scope. `unload()` is a last resort for memory-bound phased applications.

### Configuring `memReserved`

The runtime reserves part of the heap for native subsystems (WiFi, TLS, drivers). You can tune this in `mikro.config.ts`:

```ts twoslash
import {defineConfig} from 'mikrojs'

export default defineConfig({
  memReserved: 16 * 1024,
})
```

- **64 KB** (default): good for WiFi + HTTPS apps.
- **16-32 KB**: if your app doesn't use the network stack (e.g. sensor logger over UART, BLE-only).
- **Don't go below ~8 KB.** Native subsystems always need some room.

If JavaScript runs out of memory, you get a catchable `InternalError`. If the system heap runs out (native code), you get a hard reset. The reserve keeps these from happening at the same time.

### Finding memory issues

If you're hitting out-of-memory crashes, use [`memoryUsage()`](/api/sys#memoryusage) to narrow it down:

```ts twoslash
import {memoryUsage} from 'mikrojs/sys'
// ---cut---
function memCheckpoint(label: string): void {
  const m = memoryUsage()
  const freeKb = ((m.heapTotal - m.heapUsed) / 1024).toFixed(1)
  const sysMinFreeKb = (m.systemMinFree / 1024).toFixed(1)
  console.debug(`[mem] ${label}: ${freeKb} KB free (sys min-free ${sysMinFreeKb} KB)`)
}
```

Place calls before and after suspect operations. The `systemMinFree` field is especially useful: it tracks the all-time lowest free memory, catching transient spikes that have since been freed.

Once you've found the hot spot, the fix is usually one of:

- **Build data incrementally** instead of holding the full result + source in memory simultaneously
- **Reduce payload size** (fewer fields, shorter keys, less history)
- **Lower `memReserved`** if your native subsystems don't need the full reservation
- **Free references early** by scoping variables tightly or nulling them before the next big allocation (QuickJS uses reference counting, so memory is freed immediately when the last reference is dropped)

## Deep sleep for battery projects

Deep sleep drops power draw from ~80-160mA to ~10-20µA. The tradeoff: the CPU resets on wake, so your program starts from scratch.

```ts twoslash
import {deepSleep, enableTimerWakeup} from 'mikrojs/sleep'
import {rtcStorage} from 'mikrojs/kv/rtc'
import * as s from 'mikrojs/schema'

const readings = rtcStorage.createValue('readings', {
  schema: s.optional(s.number()),
})
readings.update((n) => (n ?? 0) + 1)

// Do your work (read sensor, send data, etc.)

// Sleep for 5 minutes
deepSleep(5 * 60 * 1_000_000)
```

Use [`rtcStorage`](/api/kv) to persist state across sleep cycles. It survives deep sleep but not power loss.

## Don't block the event loop

Mikro.js runs a single-threaded event loop, like Node.js. WiFi, timers, and everything else depends on it.

- Break long computations into chunks with `await sleep(0)` to yield
- Don't use tight `while(true)` loops without an `await` inside
- WiFi events are delivered through the event loop; blocking it delays reconnection handling

## Filesystem

On device, the filesystem uses [LittleFS](https://github.com/littlefs-project/littlefs) on a flash partition. Files persist across reboots and deep sleep.

Flash memory has limited write cycles (~100,000 per sector). Don't write on every loop iteration. Buffer data in RAM and write periodically, or use [`rtcStorage`](/api/kv) for frequently changing values.

## Error handling matters more

On a server, an unhandled exception crashes the process and a supervisor restarts it. On a microcontroller, an unhandled exception can leave your device stuck, potentially miles from anyone who can reset it.

This is why Mikro.js uses [typed Results](/error-handling) instead of exceptions. Every failure is visible in the type signature.

```ts twoslash
import {wifi} from 'mikrojs/wifi'
declare const ssid: string
declare const passphrase: string
// ---cut---
const result = await wifi.connect(ssid, passphrase)
if (!result.ok) {
  console.error('WiFi failed: %s', result.error.name)
  // Retry, fall back, or sleep and try later
}
```

For truly unrecoverable errors (missing config, hardware failure at boot), use `.orPanic()`. On device, you can configure automatic restart on panic so the device recovers.

## Host simulator

`mikro sim dev` runs your code on your computer. It goes through the same build pipeline as device mode and reloads on file changes.

Hardware-dependent builtins (WiFi, HTTP, GPIO, I2C, SPI, sleep) are stubbed. When your code first uses one, the simulator creates a default stub file in your project's `sim/` directory that you can customize:

```
my-project/
  app/main.ts
  sim/
    wifi.stub.ts     <- auto-created when your code uses WiFi
    pin.stub.ts      <- auto-created when your code uses GPIO
  package.json
```

Each stub file exports a default object with `methods` that handle the builtin's calls. Only override what you need; unspecified methods use defaults:

```ts
// sim/wifi.stub.ts
import type {SimStub} from 'mikrojs/sim'

export default {
  methods: {
    connect(ssid: string, _passphrase: string) {
      console.log('[sim] wifi.connect:', ssid)
      const info = {ip: '10.0.0.42', netmask: '255.255.255.0', gateway: '10.0.0.1'}
      return {ok: true as const, value: Promise.resolve({ok: true as const, value: info})}
    },
  },
} satisfies SimStub<'wifi'>
```

Stubs run in Node.js (not QuickJS), so they can use `fetch`, filesystem APIs, or any other Node.js capability for realistic simulation.

Builtins that work without stubs: `console`, `kv`, `nvs_kv` (in-memory storage), timers, `sys`.
