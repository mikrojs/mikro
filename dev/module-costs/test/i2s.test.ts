import {env} from 'mikro/env'
import {describe, test} from 'mikro/test'

// Firmware-only bytecode module, absent from the simulator build.
const onDevice = env.get('MIKRO_ENV') !== 'simulator'

describe.runIf(onDevice)('mikro/i2s', () => {
  test('import', async () => {
    await import('mikro/i2s')
  })
})
