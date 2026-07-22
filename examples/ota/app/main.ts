import {env} from 'mikro/env'
import {digitalWrite, pinMode} from 'mikro/pin'
import {sleep} from 'mikro/sleep'
import {restart} from 'mikro/sys'
import {wifi} from 'mikro/wifi'

import {withUpdates} from './updates.js'

// The blink rate is deliberately hard-coded: change it, bump the version,
// publish, and the LED shows the moment the update lands.
const BLINK_INTERVAL_MS = 400

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')
const ledPin = env.get('LED_PIN')

/** Blink an LED as a visible heartbeat. Does nothing when no LED_PIN is
 *  configured. Runs until the device restarts. */
function startHeartbeat(pin: string | undefined, intervalMs: number): () => void {
  if (pin === undefined) return () => {}
  const gpio = parseInt(pin, 10)
  pinMode(gpio, 'OUTPUT').orPanic('Failed to configure LED pin')
  let value: 0 | 1 = 0
  const interval = setInterval(() => {
    value = value === 0 ? 1 : 0
    const written = digitalWrite(gpio, value)
    if (!written.ok) console.error('LED write failed', written.error)
  }, intervalMs)

  return () => {
    clearInterval(interval)
    digitalWrite(gpio, 1).orDefault(undefined)
  }
}

console.log('connecting to wifi network %s…', ssid)
const connected = await wifi.connect({ssid, passphrase})
if (!connected.ok) {
  console.error('wifi connect failed:', connected.error)
} else {
  console.log('wifi connected')

  // The app's main program runs inside the update cycle: updates.ts checks
  // in at startup, installing a pending update before this callback runs.
  await withUpdates(async () => {
    const stopHeartbeat = startHeartbeat(ledPin, BLINK_INTERVAL_MS)

    // Your app's real work runs here. This demo blinks for a while and then
    // restarts, so the next startup check picks up any published update.
    await sleep(10_000)

    stopHeartbeat()
    restart()
  })
}
