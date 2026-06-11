/* eslint-disable no-console */
import {env} from 'mikro/env'
import {memoryUsage} from 'mikro/sys'
import {assert, beforeAll, describe, test} from 'mikro/test'

// Streaming tests live in their own file because each one does a full TLS
// handshake + body drain that peaks heap usage heavily. Running them
// alongside the other fetch-e2e tests accumulated enough heap fragmentation
// that mbedTLS would start failing allocations mid-stream. Each file gets a
// fresh boot, so in isolation these run on a clean ~95KB-free heap.
//
// Convention: any request() that might run slow under heap fragmentation
// should carry a `timeoutMs` strictly less than the test's own timeout so
// the fetch self-cancels first and releases its native background task.

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')
const hasWifi = WIFI_SSID && WIFI_PASSPHRASE
const isSim = env.get('MIKRO_ENV') === 'simulator'

// The request/wifi module graph plus TLS working room needs ~48KB of
// free JS heap (estimate; the graph alone retains ~30KB). Chips whose
// per-file runtime has less than that skip this file (e.g. esp32c3).
const m = memoryUsage()
const fitsHttp = m.heapTotal - m.heapUsed > 48 * 1024

let request: typeof import('mikro/http/request').request
let decodeUtf8: typeof import('mikro/stream').decodeUtf8
let splitLines: typeof import('mikro/stream').splitLines

describe.runIf(hasWifi && !isSim && fitsHttp)('http request streaming', () => {
  beforeAll(async () => {
    ;({request} = await import('mikro/http/request'))
    ;({decodeUtf8, splitLines} = await import('mikro/stream'))
    const {wifi} = await import('mikro/wifi')
    const connected = await wifi.connect(WIFI_SSID!, WIFI_PASSPHRASE!)
    assert.equal(connected.ok, true, 'wifi connect')
    if (connected.ok) console.log(`connected: ${connected.value.ip}`)

    // Warm up fetch + AbortController lazy-init to keep their one-time
    // ~15KB cost out of the leak baseline. The harness recaptures the
    // baseline after beforeAll resolves, so no manual reset is needed.
    const warmup = await request('https://httpbingo.org/get', {timeoutMs: 10_000})
    if (warmup.ok) await warmup.value.close()
  })

  test(
    'drain large body chunk-by-chunk without buffering peak',
    async () => {
      // 16 KB response streamed as 2 KB chunks (native side). The iterator
      // surfaces each chunk as it arrives.
      const result = await request('https://httpbingo.org/bytes/16384', {timeoutMs: 15_000})
      assert.ok(result)
      let total = 0
      let chunks = 0
      for await (const c of result.value.body) {
        assert.ok(c)
        total += c.value.length
        chunks++
      }
      assert.equal(total, 16384, 'all bytes received via stream')
      assert.truthy(chunks >= 1, 'at least one chunk observed')
      console.log(`streamed 16 KB across ${chunks} chunk(s)`)
    },
    {timeout: 30_000},
  )

  test(
    'compose with decodeUtf8 + splitLines',
    async () => {
      // stream-bytes endpoint emits multiple lines of random bytes. We just
      // verify the pipeline runs end-to-end without buffering.
      const result = await request('https://httpbingo.org/stream/5', {timeoutMs: 15_000})
      assert.ok(result)
      let lineCount = 0
      for await (const line of splitLines(decodeUtf8(result.value.body))) {
        assert.ok(line)
        if (line.value.length > 0) lineCount++
      }
      assert.truthy(lineCount >= 5, `received ${lineCount} lines (expected >= 5)`)
    },
    {timeout: 30_000},
  )
})
