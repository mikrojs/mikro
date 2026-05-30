import {gc, memoryUsage} from 'mikro/sys'

// Keep the static-import baseline as small as possible: only `mikro/sys`.
// Every other builtin is loaded below via dynamic import so we can measure
// its individual cost. mikro.config.ts sets `bundle: false` so the dynamic
// imports are real runtime module loads, not build-time inlines.

type Probe = [label: string, loader: () => Promise<unknown>]

const probes: Probe[] = [
  ['mikro/result', () => import('mikro/result')],
  ['mikro/sleep', () => import('mikro/sleep')],
  ['mikro/cbor', () => import('mikro/cbor')],
  ['mikro/console', () => import('mikro/console')],
  ['mikro/env', () => import('mikro/env')],
  ['mikro/http/helpers', () => import('mikro/http/helpers')],
  ['mikro/http/request', () => import('mikro/http/request')],
  ['mikro/format', () => import('mikro/format')],
  ['mikro/fs', () => import('mikro/fs')],
  ['mikro/i2c', () => import('mikro/i2c')],
  ['mikro/inspect', () => import('mikro/inspect')],
  ['mikro/kv/nvs', () => import('mikro/kv/nvs')],
  ['mikro/kv/rtc', () => import('mikro/kv/rtc')],
  ['mikro/neopixel', () => import('mikro/neopixel')],
  ['mikro/pin', () => import('mikro/pin')],
  ['mikro/pwm', () => import('mikro/pwm')],
  ['mikro/reader', () => import('mikro/reader')],
  ['mikro/schema', () => import('mikro/schema')],
  ['mikro/sntp', () => import('mikro/sntp')],
  ['mikro/spi', () => import('mikro/spi')],
  ['mikro/stdio', () => import('mikro/stdio')],
  ['mikro/stream', () => import('mikro/stream')],
  ['mikro/uart', () => import('mikro/uart')],
  ['mikro/wifi', () => import('mikro/wifi')],
  ['mikro/ble', () => import('mikro/ble')],
]

gc()
const start = memoryUsage()
console.log(
  `[probe] baseline sysFree=${(start.systemFree / 1000).toFixed(1)}KB sysTotal=${(start.systemTotal / 1000).toFixed(1)}KB`,
)

let lastFree = start.systemFree
const results: {label: string; delta: number}[] = []

for (const [label, loader] of probes) {
  /* eslint-disable @mikrojs/no-try-catch -- probing optional builtins */
  try {
    await loader()
    gc()
    const m = memoryUsage()
    const delta = lastFree - m.systemFree
    lastFree = m.systemFree
    results.push({label, delta})
    console.log(
      `[probe] +${label}: delta=${(delta / 1000).toFixed(2)}KB sysFree=${(m.systemFree / 1000).toFixed(1)}KB`,
    )
  } catch (e) {
    const msg = (e as {message?: string} | null)?.message ?? String(e)
    console.log(`[probe] +${label}: load failed (${msg})`)
  }
  /* eslint-enable @mikrojs/no-try-catch */
}

console.log(
  `[probe] total delta=${((start.systemFree - lastFree) / 1000).toFixed(1)}KB sysFree=${(lastFree / 1000).toFixed(1)}KB`,
)

// The sorted summary allocates a bit per line; after loading everything the
// heap can be very tight (wifi+ble alone are 90KB+). Wrap so an OOM here
// doesn't kill the probe before the per-module lines above are printed.
/* eslint-disable @mikrojs/no-try-catch -- probe summary is nice-to-have */
try {
  console.log('[probe] --- ranked by retained cost ---')
  results.sort((a, b) => b.delta - a.delta)
  for (const r of results) {
    console.log(`[probe] ${(r.delta / 1000).toFixed(2).padStart(7)}KB  ${r.label}`)
  }
} catch (e) {
  console.log(`[probe] summary skipped: ${(e as {message?: string} | null)?.message ?? e}`)
}
/* eslint-enable @mikrojs/no-try-catch */

// Halt. Long sleep keeps the runtime alive so the serial output stays on
// screen and the device doesn't idle-reset between reads.
const {sleep} = await import('mikro/sleep')
await sleep(60 * 60 * 1000)
