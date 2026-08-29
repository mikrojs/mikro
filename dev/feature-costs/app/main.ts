import {env} from 'mikro/env'
import {request} from 'mikro/http/request'
import {sleep} from 'mikro/sleep'
import {memoryUsage} from 'mikro/sys'
import {wifi} from 'mikro/wifi'

// Measures what each native subsystem actually costs on this chip, phase by
// phase: WiFi radio up (scan), association + IP, a plain HTTP request, a TLS
// request, and what a radio shutdown gives back. Two numbers per phase:
// `cost` is the settled system-heap delta the phase left behind, `peak` is
// how far the phase dug below the all-time low watermark. Phases run in
// increasing order of demand because `systemMinFree` is monotonic since
// boot: an early deep phase would mask a later smaller peak.
//
// Readings are settled system-heap figures, so they include a few hundred
// bytes of noise from this script's own JS allocations and log lines.
// Good for a per-chip cost table; not for hunting sub-KB leaks.

function count(name: string, fallback: number): number {
  const raw = env.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    console.error('%s must be a positive integer, got %s — using %d', name, raw, fallback)
    return fallback
  }
  return value
}

const SETTLE_MS = count('COST_SETTLE', 3000)
const ROUNDS = count('COST_ROUNDS', 2)
const HTTP_URL = env.get('COST_HTTP_URL') ?? 'http://httpbingo.org/get'
const HTTPS_URL = env.get('COST_HTTPS_URL') ?? 'https://httpbingo.org/get'

interface Reading {
  free: number
  minFree: number
  largest: number
  intFree: number
  intLargest: number
}

function read(): Reading {
  const m = memoryUsage()
  return {
    free: m.systemFree,
    minFree: m.systemMinFree,
    largest: m.systemLargestFree,
    intFree: m.internalFree,
    intLargest: m.internalLargestFree,
  }
}

// On PSRAM boards sysFree spans both pools and hides internal-SRAM
// pressure, so intCost tracks the pool the driver and mbedTLS actually
// allocate from. No internal watermark exists, so transient internal
// pressure is not visible — only settled internal cost.
async function settleAndReport(label: string, prev: Reading): Promise<Reading> {
  await sleep(SETTLE_MS)
  const now = read()
  const cost = prev.free - now.free
  const intCost = prev.intFree - now.intFree
  const peak = prev.minFree - now.minFree
  console.log(
    '%s: cost=%d intCost=%d peak=%d | sysFree=%d largest=%d minFree=%d intFree=%d intLargest=%d',
    label,
    cost,
    intCost,
    peak > 0 ? peak : 0,
    now.free,
    now.largest,
    now.minFree,
    now.intFree,
    now.intLargest,
  )
  return now
}

// Scan brings the radio and driver up without associating, splitting
// "driver up" from "connected". The AP list dies here, before the phase
// reading: QuickJS allocates from the system heap, so a held scan list
// (~4-5 KB on a busy channel) would read as native driver cost and as
// end-of-round residue.
async function bringUpRadio(): Promise<void> {
  const scanned = await wifi.scan()
  if (!scanned.ok) {
    console.error('wifi scan failed:', scanned.error)
  }
}

async function fetchAndDrain(url: string): Promise<void> {
  const result = await request(url, {timeoutMs: 15_000})
  if (!result.ok) {
    console.error('request failed:', result.error)
    return
  }
  // Drain the body so the connection closes cleanly.
  const body = await result.value.text()
  if (!body.ok) {
    console.error('body read failed:', body.error)
  }
}

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')

async function runRound(round: number): Promise<void> {
  const tag = `r${round}`
  const baseline = read()
  console.log(
    '%s baseline: sysFree=%d largest=%d minFree=%d intFree=%d intLargest=%d',
    tag,
    baseline.free,
    baseline.largest,
    baseline.minFree,
    baseline.intFree,
    baseline.intLargest,
  )

  await bringUpRadio()
  let last = await settleAndReport(`${tag} radio up (scan)`, baseline)

  const connected = await wifi.connect({ssid, passphrase})
  if (!connected.ok) {
    console.error('wifi connect failed:', connected.error)
  } else {
    last = await settleAndReport(`${tag} connected`, last)

    await fetchAndDrain(HTTP_URL)
    last = await settleAndReport(`${tag} http request`, last)

    await fetchAndDrain(HTTPS_URL)
    await settleAndReport(`${tag} https request (TLS)`, last)
  }

  // Radio down releases the driver heap (shutdown defaults to true). The
  // fixed floor outlives TIME_WAIT so lingering connection state does not
  // read as unreclaimed driver memory.
  const disconnected = wifi.disconnect()
  if (!disconnected.ok) {
    console.error('wifi disconnect failed:', disconnected.error)
  }
  await sleep(Math.max(SETTLE_MS, 15_000))
  const end = read()
  console.log(
    '%s after radio shutdown: sysFree=%d largest=%d intFree=%d intLargest=%d | residue vs baseline=%d intResidue=%d',
    tag,
    end.free,
    end.largest,
    end.intFree,
    end.intLargest,
    baseline.free - end.free,
    baseline.intFree - end.intFree,
  )
}

// Round 1 starts from a boot-polluted baseline (allocations still draining)
// but owns the peak figures: `systemMinFree` is monotonic since boot with no
// reset, so later rounds read peak=0. Round 2 starts from the post-shutdown
// floor, so its settled costs are the trustworthy ones. A non-zero round-2
// residue is a real per-cycle leak, not boot noise.
await sleep(SETTLE_MS)
for (let round = 1; round <= ROUNDS; round++) {
  await runRound(round)
}
