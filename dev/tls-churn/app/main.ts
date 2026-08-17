import {env} from 'mikro/env'
import {request} from 'mikro/http/request'
import {sleep} from 'mikro/sleep'
import {memoryUsage} from 'mikro/sys'
import {wifi} from 'mikro/wifi'

// Repeated TLS rounds against one host, logging heap state before and after
// each. The number to watch is the `pre` largest block: if it ratchets down
// round over round, connection residue is fragmenting the heap; if it
// settles, the current build holds. Override the knobs via env when needed.
// The host matters: its certificate chain decides which verification path the
// bundle takes, so an A/B is only comparable against the same URL.
const URL = env.get('CHURN_URL') ?? 'https://httpbingo.org/get'

// A typo'd knob must not read as a clean run: NaN would skip the loop or
// silence every log line and still print a plausible "done".
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

const INTERVAL_MS = count('CHURN_INTERVAL', 10000)
const ROUNDS = count('CHURN_ROUNDS', 20)
// Log every Nth round. The observed ~214 B/round sysFree drift matches the
// size of one log line; running quiet separates a per-connection leak (drift
// unchanged) from a per-log-line one (drift shrinks with the line count).
const LOG_EVERY = count('CHURN_LOG_EVERY', 1)

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')

console.log('connecting to wifi network %s…', ssid)
const connected = await wifi.connect({ssid, passphrase})
if (!connected.ok) {
  console.error('wifi connect failed:', connected.error)
} else {
  console.log('churn: %d rounds against %s, every %dms', ROUNDS, URL, INTERVAL_MS)
  const boot = memoryUsage()
  console.log('churn: at start sysFree=%d largest=%d', boot.systemFree, boot.systemLargestFree)

  for (let round = 1; round <= ROUNDS; round++) {
    const pre = memoryUsage()
    const started = Date.now()
    let outcome: string
    const result = await request(URL, {timeoutMs: 15_000})
    if (result.ok) {
      // Drain the body so the connection closes cleanly.
      const body = await result.value.text()
      outcome = body.ok
        ? `${result.value.status} (${body.value.length} bytes)`
        : `${result.value.status}, body failed: ${body.error.name}`
    } else {
      outcome =
        'message' in result.error
          ? `${result.error.name}: ${result.error.message}`
          : result.error.name
    }
    const post = memoryUsage()
    if (round % LOG_EVERY !== 0) {
      await sleep(INTERVAL_MS)
      continue
    }
    console.log(
      'churn %d/%d: %s in %dms | pre sysFree=%d largest=%d | post sysFree=%d largest=%d jsUsed=%d',
      round,
      ROUNDS,
      outcome,
      Date.now() - started,
      pre.systemFree,
      pre.systemLargestFree,
      post.systemFree,
      post.systemLargestFree,
      post.heapUsed,
    )
    await sleep(INTERVAL_MS)
  }

  // One settled reading after the last round's residue had time to drain.
  // Fixed floor so a fast-interval run still outlives TIME_WAIT (12s with
  // the trimmed MSL) before the number that matters is taken.
  await sleep(Math.max(INTERVAL_MS, 15_000))
  const end = memoryUsage()
  console.log(
    'churn: done. sysFree=%d largest=%d minFree=%d',
    end.systemFree,
    end.systemLargestFree,
    end.systemMinFree,
  )
}
