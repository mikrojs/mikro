import {encode as cborEncode} from 'mikrojs/cbor'
import {env} from 'mikrojs/env'
import {ok} from 'mikrojs/result'
import {parse, string} from 'mikrojs/schema'
import {stdout} from 'mikrojs/stdio'
import {version} from 'mikrojs/sys'
import {assert, describe, test} from 'mikrojs/test'

// Verify built-in modules load and export the right types.
// Hardware modules that cost ~6KB each are split across files
// so each gets a fresh heap.

describe('module: pin', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/pin')
    assert.type(mod.pinMode, 'function')
    assert.type(mod.digitalWrite, 'function')
    assert.type(mod.digitalRead, 'function')
    assert.type(mod.analogRead, 'function')
    assert.type(mod.analogReadMillivolts, 'function')
  })
})

describe('module: pwm', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/pwm')
    assert.type(mod.Pwm, 'function')
  })
})

describe('module: neopixel', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/neopixel')
    assert.type(mod.NeoPixel, 'function')
  })
})

describe('module: i2c', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/i2c')
    assert.type(mod.I2c, 'function')
  })
})

describe('module: spi', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/spi')
    assert.type(mod.Spi, 'function')
  })
})

describe('module: sleep', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/sleep')
    assert.type(mod.sleep, 'function')
    assert.type(mod.getWakeupCause, 'function')
    assert.type(mod.deepSleep, 'function')
    assert.type(mod.lightSleep, 'function')
  })

  test('getWakeupCause returns a string', async () => {
    const {getWakeupCause} = await import('mikrojs/sleep')
    const cause = getWakeupCause()
    assert.type(cause, 'string')
  })

  test('sleep resolves after delay', async () => {
    const {sleep} = await import('mikrojs/sleep')
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    assert.truthy(elapsed >= 40, `expected >= 40ms, got ${elapsed}`)
  })
})

describe('module: stdio', () => {
  test('stdout.write exists', () => {
    assert.type(stdout.write, 'function')
  })
})

describe('module: env (smoke)', () => {
  test('env.get/has/require exist', () => {
    assert.type(env.get, 'function')
    assert.type(env.has, 'function')
    assert.type(env.require, 'function')
  })
})

describe('module: result (smoke)', () => {
  test('ok/err are callable', () => {
    assert.equal(ok(1).ok, true)
  })
})

describe('module: schema (smoke)', () => {
  test('parse is callable', () => {
    assert.ok(parse(string(), 'test'))
  })
})

describe('module: cbor (smoke)', () => {
  test('encode is callable', () => {
    assert.ok(cborEncode(42))
  })
})

describe('module: sys (smoke)', () => {
  test('version is accessible', () => {
    assert.type(version, 'string')
  })
})
