import {assert, describe, test} from 'mikro/test'

describe('module: wifi', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/wifi')
    assert.type(mod.wifi, 'object')
    assert.type(mod.wifi.connect, 'function')
    assert.type(mod.wifi.disconnect, 'function')
    assert.type(mod.wifi.scan, 'function')
    assert.type(mod.wifi.status, 'function')
  })
})

describe('module: http/request', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/http/request')
    assert.type(mod.request, 'function')
  })
})

describe('module: sntp', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/sntp')
    assert.type(mod.sntp, 'object')
    assert.type(mod.sntp.sync, 'function')
  })
})
