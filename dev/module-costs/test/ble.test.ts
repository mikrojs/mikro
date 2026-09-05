import {board} from 'mikro/sys'
import {describe, test} from 'mikro/test'

// Only built into firmware for chips with BLE, and absent from the
// simulator. Skipped elsewhere so the file records nothing for that chip
// rather than a pedestal-only figure.
describe.runIf(board.features.includes('ble'))('mikro/ble', () => {
  test('import', async () => {
    await import('mikro/ble')
  })
})
