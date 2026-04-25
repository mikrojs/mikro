import {digitalWrite, pinMode} from 'mikrojs/pin'
import {sleep} from 'mikrojs/sleep'

let value: 0 | 1 = 0
// GPIO 15 is the built-in LED on XIAO ESP32C6. Replace with your board's LED pin.
const PIN = 15

pinMode(PIN, 'OUTPUT').orPanic('Failed to configure LED pin')

while (true) {
  value = value === 0 ? 1 : 0
  const writeResult = digitalWrite(PIN, value)
  if (!writeResult.ok) {
    console.error('Write pin failed: %s', writeResult.error.name)
  }

  await sleep(1000)
}
