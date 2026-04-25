import {gc, memoryUsage} from 'mikrojs/sys'

// Keep the static-import baseline as small as possible: only `mikrojs/sys`.
// Every other builtin is loaded below via dynamic import so we can measure
// its individual cost. mikro.config.ts sets `bundle: false` so the dynamic
// imports are real runtime module loads, not build-time inlines.

type Probe = [label: string, loader: () => Promise<unknown>]

const probes: Probe[] = [
  ['mikrojs/result', () => import('mikrojs/result')],
  ['mikrojs/sleep', () => import('mikrojs/sleep')],
  ['mikrojs/cbor', () => import('mikrojs/cbor')],
  ['mikrojs/console', () => import('mikrojs/console')],
  ['mikrojs/env', () => import('mikrojs/env')],
  ['mikrojs/http/helpers', () => import('mikrojs/http/helpers')],
  ['mikrojs/http/request', () => import('mikrojs/http/request')],
  ['mikrojs/format', () => import('mikrojs/format')],
  ['mikrojs/fs', () => import('mikrojs/fs')],
  ['mikrojs/i2c', () => import('mikrojs/i2c')],
  ['mikrojs/inspect', () => import('mikrojs/inspect')],
  ['mikrojs/kv/nvs', () => import('mikrojs/kv/nvs')],
  ['mikrojs/kv/rtc', () => import('mikrojs/kv/rtc')],
  ['mikrojs/neopixel', () => import('mikrojs/neopixel')],
  ['mikrojs/pin', () => import('mikrojs/pin')],
  ['mikrojs/pwm', () => import('mikrojs/pwm')],
  ['mikrojs/reader', () => import('mikrojs/reader')],
  ['mikrojs/schema', () => import('mikrojs/schema')],
  ['mikrojs/sntp', () => import('mikrojs/sntp')],
  ['mikrojs/spi', () => import('mikrojs/spi')],
  ['mikrojs/stdio', () => import('mikrojs/stdio')],
  ['mikrojs/stream', () => import('mikrojs/stream')],
  ['mikrojs/uart', () => import('mikrojs/uart')],
  ['mikrojs/wifi', () => import('mikrojs/wifi')],
  ['mikrojs/ble', () => import('mikrojs/ble')],
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
const {sleep} = await import('mikrojs/sleep')
await sleep(60 * 60 * 1000)
