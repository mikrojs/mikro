import {memoryUsage} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

// Hardware modules loaded together: each costs ~6KB of heap once
// imported, ~40KB retained for the whole set (measured on esp32c6).
// The gate adds ~8KB of margin for import-time evaluation peaks, so
// chips whose per-file runtime has less free heap (e.g. esp32c3) skip
// this file. Note: when skipped, spi and neopixel have no other
// JS-level e2e coverage (pin/pwm/i2c/sleep are also covered by the
// firmware's C doctest suite).

const m = memoryUsage()
const runsHwModules = m.heapTotal - m.heapUsed > 48 * 1024

describe.runIf(runsHwModules)('module: pin', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/pin')
    assert.type(mod.pinMode, 'function')
    assert.type(mod.digitalWrite, 'function')
    assert.type(mod.digitalRead, 'function')
    assert.type(mod.analogRead, 'function')
    assert.type(mod.analogReadMillivolts, 'function')
  })
})

describe.runIf(runsHwModules)('module: pwm', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/pwm')
    assert.type(mod.Pwm, 'function')
  })
})

describe.runIf(runsHwModules)('module: neopixel', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/neopixel')
    assert.type(mod.NeoPixel, 'function')
  })
})

describe.runIf(runsHwModules)('module: i2c', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/i2c')
    assert.type(mod.I2c, 'function')
  })
})

describe.runIf(runsHwModules)('module: spi', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/spi')
    assert.type(mod.Spi, 'function')
  })
})

describe.runIf(runsHwModules)('module: sleep', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/sleep')
    assert.type(mod.sleep, 'function')
    assert.type(mod.deepSleep, 'function')
    assert.type(mod.lightSleep, 'function')
    assert.type(mod.canWakeFromExt0, 'function')
    assert.type(mod.canWakeFromExt1, 'function')
  })

  test('getWakeupCause returns a string', async () => {
    const {getWakeupCause} = await import('mikro/sys')
    const cause = getWakeupCause()
    assert.type(cause, 'string')
  })

  test('sleep resolves after delay', async () => {
    const {sleep} = await import('mikro/sleep')
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    assert.truthy(elapsed >= 40, `expected >= 40ms, got ${elapsed}`)
  })
})
