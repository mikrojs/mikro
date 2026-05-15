/* eslint-disable no-console */
import {env} from 'mikrojs/env'
import {request} from 'mikrojs/http/request'
import {assert, beforeAll, describe, test} from 'mikrojs/test'
import {wifi} from 'mikrojs/wifi'

// These tests require WIFI_SSID and WIFI_PASSPHRASE env vars to run on
// the device. They exercise the full JS → native:http → esp_http_client
// stack against real endpoints.
//
// Convention: any request() that might run slow under heap fragmentation
// (streaming or large body) should carry a `timeoutMs` strictly less than
// the test's own timeout, so the fetch self-cancels first and releases its
// native background task + pending slot. If a test's outer timeout fires
// before the fetch's, the BG task keeps running until the server replies
// and will eat heap that subsequent tests need.

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')
const hasWifi = WIFI_SSID && WIFI_PASSPHRASE
// These tests hit real httpbingo.org endpoints; the sim http stub can't
// produce realistic responses for them, so skip in simulator mode.
const isSim = env.get('MIKRO_ENV') === 'simulator'

describe.runIf(hasWifi && !isSim)('http request e2e', () => {
  beforeAll(async () => {
    const connected = await wifi.connect(WIFI_SSID!, WIFI_PASSPHRASE!)
    assert.equal(connected.ok, true, 'wifi connect')
    if (connected.ok) console.log(`connected: ${connected.value.ip}`)

    // Warm up fetch + AbortController. Lazy-initialized classes and the
    // fetch/transport/native:http module load account for ~15KB of
    // one-time heap cost that would otherwise be attributed to whichever
    // test touches them first. The harness recaptures the baseline after
    // beforeAll resolves, so no manual reset is needed.
    const warmup = await request('https://httpbingo.org/get')
    if (warmup.ok) await warmup.value.close()
    new AbortController() // trigger lazy class install
  })

  test('GET over TLS returns status 200 and JSON', async () => {
    const result = await request('https://httpbingo.org/get', {
      headers: {'content-type': 'application/json'},
    })
    assert.ok(result, `fetch failed: ${result.ok ? '' : result.error.name}`)
    assert.equal(result.value.status, 200)
    assert.truthy(result.value.ok, 'response.ok reflects 2xx')
    const body = await result.value.json()
    assert.ok(body)
    assert.type(body.value, 'object')
  })

  test('GET returns a non-empty body as bytes', async () => {
    const result = await request('https://httpbingo.org/bytes/1024')
    assert.ok(result)

    const bytes = await result.value.bytes()
    assert.ok(bytes)
    assert.equal(bytes.value.length, 1024, `expected 1024 bytes, got ${bytes.value.length}`)
  })

  test('non-2xx status surfaces as response.ok=false with body still readable', async () => {
    const result = await request('https://httpbingo.org/status/404')
    assert.ok(result)
    assert.equal(result.value.status, 404)
    assert.equal(result.value.ok, false)
    await result.value.close()
  })

  test('response headers are reported as pairs; get() is case-insensitive', async () => {
    const result = await request('https://httpbingo.org/get')
    assert.ok(result)
    const ct = result.value.get('content-type')
    assert.type(ct, 'string')
    assert.truthy(ct!.includes('application/json'), 'content-type contains application/json')
    await result.value.close()
  })

  test('AbortSignal cancels an in-flight request', async () => {
    const controller = new AbortController()
    // Slow endpoint: /delay/5 sleeps 5s before responding.
    const promise = request('https://httpbingo.org/delay/5', {signal: controller.signal})
    // Let the request start, then abort.
    setTimeout(() => controller.abort(), 200)
    const result = await promise
    assert.err(result)
    assert.equal(result.error.name, 'Aborted')
  })

  test('timeoutMs cancels a long-running request', async () => {
    const result = await request('https://httpbingo.org/delay/5', {timeoutMs: 200})
    assert.err(result)
    assert.equal(result.error.name, 'Aborted')
  })

  test('unreachable host surfaces as Network error (pre-headers)', async () => {
    // example.invalid TLD is reserved and must not resolve.
    const result = await request('https://nonexistent.example.invalid/')
    assert.err(result)
    assert.equal(result.error.name, 'Network')
    if (result.error.name === 'Network') {
      console.log(`expected network error: ${result.error.message}`)
    }
  })

  test('POST with JSON body round-trips through httpbin /post', async () => {
    const result = await request('https://httpbingo.org/post', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({hello: 'mikro', n: 42}),
    })
    assert.ok(result)
    assert.equal(result.value.status, 200)
    const body = await result.value.json()
    assert.ok(body)
    const parsed = body.value as {json: {hello: string; n: number}}
    assert.equal(parsed.json.hello, 'mikro')
    assert.equal(parsed.json.n, 42)
  })

  test(
    'break inside for-await cancels the request and frees the pending slot',
    async () => {
      // The test harness captures pendingCount() from native:http before
      // run() and after, emits both on the run_done event, and the CLI
      // surfaces any leaked in-flight requests as a teardown warning. So
      // we only need to exercise the break path — if cancel+drain didn't
      // release the slot, this file's final pendingDelta would be nonzero
      // and the runner would flag it.
      const result = await request('https://httpbingo.org/stream/5')
      assert.ok(result)

      let seen = 0
      for await (const _ of result.value.body) {
        seen++
        if (seen === 1) break
      }
      assert.equal(seen, 1, 'only first chunk consumed')
    },
    {timeout: 30_000},
  )
})
