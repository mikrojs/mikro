import {memoryUsage} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

// Network-related modules in a separate file: wifi, fetch, and sntp
// each cost ~6-8KB of bytecode. Combined with pin/pwm/etc they exceed
// the heap on constrained devices. Loading all three together retains
// ~46KB (measured on esp32c6); the gate's extra ~10KB covers
// import-time evaluation peaks above the retained size. Chips with
// less free heap in the per-file runtime (e.g. esp32c3) skip this
// file.

const m = memoryUsage()
const runsNetworkModules = m.heapTotal - m.heapUsed > 56 * 1024

describe.runIf(runsNetworkModules)('module: wifi', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/wifi')
    assert.type(mod.wifi, 'object')
    assert.type(mod.wifi.connect, 'function')
    assert.type(mod.wifi.disconnect, 'function')
    assert.type(mod.wifi.scan, 'function')
    assert.type(mod.wifi.status, 'function')
  })
})

describe.runIf(runsNetworkModules)('module: http/request', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/http/request')
    assert.type(mod.request, 'function')
  })
})

describe.runIf(runsNetworkModules)('module: sntp', () => {
  test('exports exist', async () => {
    const mod = await import('mikro/sntp')
    assert.type(mod.sntp, 'object')
    assert.type(mod.sntp.sync, 'function')
  })
})
