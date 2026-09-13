/* eslint-disable no-console */
import {env} from 'mikro/env'
import {memoryUsage} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

// These tests only run when WIFI_SSID and WIFI_PASSPHRASE env vars are set.
// They exercise wifi connection, fetch, and sntp against real networks.

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')

const hasWifi = WIFI_SSID && WIFI_PASSPHRASE

const m = memoryUsage()

// The firmware refuses to start the radio under 40KB of free internal RAM
// (it would otherwise abort() in PHY init), and by the time that check runs
// the wifi module graph and driver init have already cost ~55-60KB of it.
// That puts the entry bar at 100KB of internalFree (systemFree also counts
// PSRAM). Measured on esp32c3: from ~111KB at entry this file connects,
// fetches over plain http and syncs sntp with 46.7KB still free at its low
// point. TLS needs more; the http files carry their own 128KB bar.
// internalFree is 0 on the host sim, where the stubbed radio costs nothing.
const fitsRadio = m.internalFree === 0 || m.internalFree > 100 * 1024

describe.runIf(hasWifi && fitsRadio)('wifi e2e', () => {
  // A failed first attempt costs the attempt (~4-6s) plus the 2s retry
  // backoff before the second try, so a single radio hiccup overruns the
  // 10s default and cascades into the dependent tests below. 25s covers
  // one full retry cycle.
  test(
    'connect to wifi',
    async () => {
      const {wifi} = await import('mikro/wifi')
      const result = await wifi.connect({ssid: WIFI_SSID!, passphrase: WIFI_PASSPHRASE!})
      assert.equal(result.ok, true)
      assert.truthy(result.ok && result.value.ip, 'should have an IP address')
      if (result.ok) console.log(`connected: ${result.value.ip}`)
    },
    {timeout: 25_000},
  )

  test('http request', async () => {
    const {request} = await import('mikro/http/request')
    const result = await request('http://httpbingo.org/get')
    assert.ok(result)
    assert.truthy(result.ok && result.value.status === 200)
    if (result.ok) await result.value.close()
  })

  // 20s: NTP over UDP retries on loss, and a slow DNS answer for the pool
  // hostname eats into the budget before the first packet leaves.
  test(
    'sntp sync',
    async () => {
      const {sntp} = await import('mikro/sntp')
      const result = await sntp.sync({servers: ['pool.ntp.org']})
      assert.ok(result)
      const now = Date.now()
      assert.truthy(now > 1735689600000, `Date.now() looks wrong after sync: ${now}`)
      console.log(`time synced: ${new Date(now).toISOString()}`)
    },
    {timeout: 20_000},
  )

  test('wifi disconnect', async () => {
    const {wifi} = await import('mikro/wifi')
    assert.ok(wifi.disconnect())
  })
})
