import {ChipTemperature} from '@mikrojs-examples/chip-temperature'
import {sleep} from 'mikro/sleep'

const sensor = ChipTemperature().orPanic('Chip temperature sensor unavailable')

while (true) {
  const celsius = sensor.read().orPanic('Reading the chip temperature failed')
  console.log('Chip temperature: %s °C', celsius.toFixed(1))
  await sleep(2000)
}
