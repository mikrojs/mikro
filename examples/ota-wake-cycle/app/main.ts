import {env} from 'mikro/env'
import * as ota from 'mikro/ota/client'
import {deepSleep} from 'mikro/sleep'
import {getWakeupCause, restart, uptime} from 'mikro/sys'
import {wifi} from 'mikro/wifi'

// Wake every minute so an update lands while you watch. A battery-powered
// sensor would sleep for hours; every value here works the same way.
const SLEEP_MS = 60_000

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')

console.log('awake (%s)', getWakeupCause())

const connected = await wifi.connect({ssid, passphrase})
if (!connected.ok) {
  // Nothing to check without a network; do the cycle's work and go back to
  // sleep. A freshly installed build that keeps landing here never confirms
  // its trial, which is what eventually reverts it; see trialBoots below.
  console.error('wifi connect failed:', connected.error)
} else {
  // One shot per wake: reconcile the previous update, check in, and stage any
  // offered build. The check-in doubles as the trial confirmation for a build
  // installed on the previous cycle.
  //
  // trialBoots: 3 because a deep-sleep wake counts as a clean trial boot. With
  // the default of 1, a single wake without WiFi would roll back a perfectly
  // healthy build; three wakes of grace lets it ride out a flaky network while
  // a build that can never check in still reverts.
  const checked = await ota.check({trialBoots: 3})
  if (checked.status === 'staged') {
    // Restarting installs the staged build and runs the next cycle on it.
    // If the cycle had work in flight, you would finish it first and restart
    // instead of deep-sleeping at the bottom.
    console.log('update staged; restarting to install')
    restart()
  }
}

// The cycle's real work goes here: read a sensor, report, and so on.
console.log('cycle done in %dms; sleeping for %ds', uptime().boot, SLEEP_MS / 1000)
deepSleep(SLEEP_MS)
