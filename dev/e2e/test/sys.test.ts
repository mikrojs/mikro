import {board, firmware, gc, memoryUsage, MonotonicTimestamp, uptime, version} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

describe('sys', () => {
  test('version is a string', () => {
    assert.type(version, 'string')
    assert.truthy(version.length > 0, 'version should not be empty')
  })

  test('board has expected properties', () => {
    assert.type(board, 'object')
    assert.type(board.chip, 'string')
    assert.truthy(board.chip.length > 0)
    assert.type(board.cores, 'number')
    assert.truthy(board.cores > 0)
  })

  test('firmware has expected properties', () => {
    assert.type(firmware, 'object')
    assert.type(firmware.idfVersion, 'string')
  })

  test('uptime returns valid values', () => {
    const u = uptime()
    assert.type(u.boot, 'number')
    assert.type(u.rtc, 'number')
    assert.truthy(u.boot > 0, 'boot uptime should be > 0')
    assert.truthy(u.rtc > 0, 'rtc uptime should be > 0')
  })

  test('memoryUsage returns valid values', () => {
    const m = memoryUsage()
    assert.type(m.heapUsed, 'number')
    assert.type(m.heapTotal, 'number')
    assert.truthy(m.heapUsed > 0)
    assert.truthy(m.heapTotal > 0)
    assert.truthy(m.heapUsed <= m.heapTotal)
  })

  test('gc runs without error', () => {
    gc()
  })

  test('MonotonicTimestamp.now()', () => {
    const t1 = MonotonicTimestamp.now()
    assert.type(t1.uptimeMs, 'number')
    assert.truthy(t1.uptimeMs > 0)
  })

  test('MonotonicTimestamp.since() measures elapsed time', async () => {
    const t1 = MonotonicTimestamp.now()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const t2 = MonotonicTimestamp.now()
    const elapsed = t2.since(t1)
    assert.truthy(elapsed >= 40, `expected >= 40ms elapsed, got ${elapsed}`)
    assert.truthy(elapsed < 500, `expected < 500ms elapsed, got ${elapsed}`)
  })
})
