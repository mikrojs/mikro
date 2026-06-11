/* eslint-disable no-console */
import {env} from 'mikro/env'
import {memoryUsage} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

// These tests only run when WIFI_SSID and WIFI_PASSPHRASE env vars are set.
// They exercise wifi connection, fetch, and sntp against real networks.

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')

const hasWifi = WIFI_SSID && WIFI_PASSPHRASE

// The fetch and sntp tests load their module graphs on top of an
// already-connected wifi stack (~20KB retained); together that needs
// ~48KB of free JS heap (estimate). Chips with less skip those two
// tests but still cover connect/disconnect (e.g. esp32c3).
const m = memoryUsage()
const fitsFetch = m.heapTotal - m.heapUsed > 48 * 1024

describe.runIf(hasWifi)('wifi e2e', () => {
  test('connect to wifi', async () => {
    const {wifi} = await import('mikro/wifi')
    const result = await wifi.connect(WIFI_SSID!, WIFI_PASSPHRASE!)
    assert.equal(result.ok, true)
    assert.truthy(result.ok && result.value.ip, 'should have an IP address')
    if (result.ok) console.log(`connected: ${result.value.ip}`)
  })

  test.runIf(fitsFetch)('http request', async () => {
    const {request} = await import('mikro/http/request')
    const result = await request('http://httpbingo.org/get')
    assert.ok(result)
    assert.truthy(result.ok && result.value.status === 200)
    if (result.ok) await result.value.close()
  })

  test.runIf(fitsFetch)('sntp sync', async () => {
    const {sntp} = await import('mikro/sntp')
    const result = await sntp.sync({servers: ['pool.ntp.org']})
    assert.ok(result)
    const now = Date.now()
    assert.truthy(now > 1735689600000, `Date.now() looks wrong after sync: ${now}`)
    console.log(`time synced: ${new Date(now).toISOString()}`)
  })

  test('wifi disconnect', async () => {
    const {wifi} = await import('mikro/wifi')
    assert.ok(wifi.disconnect())
  })
})
