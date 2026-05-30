/* eslint-disable no-console */
import {env} from 'mikrojs/env'
import {assert, describe, test} from 'mikrojs/test'

// These tests only run when WIFI_SSID and WIFI_PASSPHRASE env vars are set.
// They exercise wifi connection, fetch, and sntp against real networks.

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')

const hasWifi = WIFI_SSID && WIFI_PASSPHRASE

describe.runIf(hasWifi)('wifi e2e', () => {
  test('connect to wifi', async () => {
    const {wifi} = await import('mikrojs/wifi')
    const result = await wifi.connect(WIFI_SSID!, WIFI_PASSPHRASE!)
    assert.equal(result.ok, true)
    assert.truthy(result.ok && result.value.ip, 'should have an IP address')
    if (result.ok) console.log(`connected: ${result.value.ip}`)
  })

  test('http request', async () => {
    const {request} = await import('mikrojs/http/request')
    const result = await request('http://httpbingo.org/get')
    assert.ok(result)
    assert.truthy(result.ok && result.value.status === 200)
    if (result.ok) await result.value.close()
  })

  test('sntp sync', async () => {
    const {sntp} = await import('mikrojs/sntp')
    const result = await sntp.sync({servers: ['pool.ntp.org']})
    assert.ok(result)
    const now = Date.now()
    assert.truthy(now > 1735689600000, `Date.now() looks wrong after sync: ${now}`)
    console.log(`time synced: ${new Date(now).toISOString()}`)
  })

  test('wifi disconnect', async () => {
    const {wifi} = await import('mikrojs/wifi')
    assert.ok(wifi.disconnect())
  })
})
