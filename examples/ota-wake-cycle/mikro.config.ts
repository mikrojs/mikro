import {defineConfig} from 'mikro'

export default defineConfig({
  wifi: {country: 'NO'},
  // A cycle that never ends (WiFi that never associates, a fetch that never
  // settles) would otherwise keep the device awake until the battery is flat.
  // The limit must clear the slowest cycle: WiFi retries, TLS, a check-in
  // and a full download in one wake. A normal cycle here takes a few seconds.
  watchdog: {awake: 120_000},
  // When it fires, sleep as if the cycle had finished, so the device stays on
  // its schedule and checks in again on the next wake.
  onPanic: {mode: 'deepSleep', delay: 0, duration: 60_000},
})
