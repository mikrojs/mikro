import {env} from 'mikro/env'
import * as ota from 'mikro/ota/client'
import {digitalWrite, pinMode} from 'mikro/pin'
import {wifi} from 'mikro/wifi'

// The blink rate is deliberately hard-coded: change it, bump the version,
// publish, and the LED shows the moment the update lands.
const BLINK_INTERVAL_MS = 400

// Check every minute so a published update lands while you watch. An
// unattended fleet would keep the default cadence (30 minutes) instead.
const CHECKIN_INTERVAL_MS = 60_000

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')
const ledPin = env.get('LED_PIN')

/** Blink an LED as a visible heartbeat. Does nothing when no LED_PIN is
 *  configured. Runs until the device restarts. */
function startHeartbeat(pin: string | undefined, intervalMs: number): void {
  if (pin === undefined) return
  const gpio = parseInt(pin, 10)
  pinMode(gpio, 'OUTPUT').orPanic('Failed to configure LED pin')
  let value: 0 | 1 = 0
  setInterval(() => {
    value = value === 0 ? 1 : 0
    const written = digitalWrite(gpio, value)
    if (!written.ok) console.error('LED write failed', written.error)
  }, intervalMs)
}

console.log('connecting to wifi network %s…', ssid)
const connected = await wifi.connect({ssid, passphrase})
if (!connected.ok) {
  console.error('wifi connect failed:', connected.error)
} else {
  console.log('wifi connected')

  // The whole update machinery is this call: it reconciles the previous boot's
  // update, checks the registry on a jittered cadence, downloads and stages an
  // offered build, and restarts to install it. A staged build runs as a trial;
  // a completed check-in confirms it, and a build that can't check in reverts.
  //
  // WiFi stays up for the life of this app, so no hook is needed. A device
  // that powers its radio down between checks brings it up in `beforeCheck`
  // and takes it down in the teardown that hook returns.
  ota.watch({checkinIntervalMs: CHECKIN_INTERVAL_MS})

  startHeartbeat(ledPin, BLINK_INTERVAL_MS)
}
