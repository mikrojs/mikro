import {assert, describe, test} from 'mikrojs/test'

// Network-related modules in a separate file: wifi, fetch, and sntp
// each cost ~6-8KB of bytecode. Combined with pin/pwm/etc they exceed
// the heap on constrained devices.

describe('module: wifi', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/wifi')
    assert.type(mod.wifi, 'object')
    assert.type(mod.wifi.connect, 'function')
    assert.type(mod.wifi.disconnect, 'function')
    assert.type(mod.wifi.scan, 'function')
    assert.type(mod.wifi.status, 'function')
  })
})

describe('module: http/request', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/http/request')
    assert.type(mod.request, 'function')
  })
})

describe('module: sntp', () => {
  test('exports exist', async () => {
    const mod = await import('mikrojs/sntp')
    assert.type(mod.sntp, 'object')
    assert.type(mod.sntp.sync, 'function')
  })
})
