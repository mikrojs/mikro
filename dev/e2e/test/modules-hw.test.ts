import {assert, describe, test} from 'mikro/test'

describe('module: gpio', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/gpio')
    assert.type(mod.DigitalOut, 'function')
    assert.type(mod.DigitalIn, 'function')
    assert.type(mod.AnalogIn, 'function')
  })
})

describe('module: pwm', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/pwm')
    assert.type(mod.Pwm, 'function')
  })
})

describe('module: neopixel', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/neopixel')
    assert.type(mod.NeoPixel, 'function')
  })
})

describe('module: i2c', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/i2c')
    assert.type(mod.I2c, 'function')
  })
})

describe('module: spi', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/spi')
    assert.type(mod.Spi, 'function')
  })
})

describe('module: sleep', () => {
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
