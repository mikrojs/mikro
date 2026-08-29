import {env} from 'mikro/env'
import {memoryUsage} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

// Soak for the modem-sleep wake path: with STA power save on, the driver
// sleeps between beacons and wakes for TIM on a code path the firmware
// runs from flash (ESP_WIFI_SLP_IRAM_OPT=n). Idling connected for a
// stretch and then talking again catches regressions there: a broken
// wake path shows up as a dropped association or a dead first request
// after the idle window.

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')

// Device-only: the simulator's wifi stub has no power save, and a
// 12-second idle against a stub proves nothing.
const onDevice = env.get('MIKRO_ENV') !== 'simulator'
const hasWifi = WIFI_SSID && WIFI_PASSPHRASE && onDevice

const m = memoryUsage()
const fitsFetch = m.heapTotal - m.heapUsed > 48 * 1024

// The radio pre-flight needs ~128KB of free system heap at file entry;
// the derivation is in wifi-e2e.test.ts next to its fitsRadio.
const fitsRadio = m.systemFree > 128 * 1024

// ~120 beacon intervals at the usual 102.4ms — long enough that a wake
// path that corrupts state or misses TIM windows gets caught, short
// enough not to dominate the suite.
const IDLE_MS = 12_000

describe.runIf(hasWifi && fitsRadio)('wifi modem-sleep', () => {
  test(
    'connect with power save active',
    async () => {
      const {wifi} = await import('mikro/wifi')
      const result = await wifi.connect({ssid: WIFI_SSID!, passphrase: WIFI_PASSPHRASE!})
      assert.equal(result.ok, true)
      wifi.powerSave = 'min'
      assert.equal(wifi.powerSave, 'min')
    },
    {timeout: 25_000},
  )

  test(
    'stays associated through an idle window',
    async () => {
      const {wifi} = await import('mikro/wifi')
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS))
      assert.equal(wifi.isConnected, true)
      assert.truthy(wifi.ip(), 'should still have an IP after idling in modem sleep')
    },
    {timeout: IDLE_MS + 10_000},
  )

  test.runIf(fitsFetch)('http request works after the idle window', async () => {
    const {request} = await import('mikro/http/request')
    const result = await request('http://httpbingo.org/get')
    assert.ok(result)
    assert.truthy(result.ok && result.value.status === 200)
    if (result.ok) await result.value.close()
  })

  test('disconnect', async () => {
    const {wifi} = await import('mikro/wifi')
    assert.ok(wifi.disconnect())
  })
})
