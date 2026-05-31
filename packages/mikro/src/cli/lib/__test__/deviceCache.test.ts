import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The cache dir is redirected to a throwaway temp dir per test, and SerialPort
// is mocked so rememberDeviceForPort can resolve a path to a serial number.
const state = vi.hoisted(() => ({dir: ''}))
vi.mock('../envPaths.js', () => ({
  paths: {
    get cache() {
      return state.dir
    },
  },
}))

const listMock = vi.hoisted(() => vi.fn())
vi.mock('serialport', () => ({SerialPort: {list: listMock}}))

const {deviceCacheFilePath, getCachedChip, getCachedDeviceId, rememberDeviceForPort} =
  await import('../deviceCache.js')

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'mikro-cache-'))
  listMock.mockResolvedValue([
    {path: '/dev/a', serialNumber: 'S1'},
    {path: '/dev/b', serialNumber: 'S2'},
  ])
})

afterEach(() => {
  rmSync(state.dir, {recursive: true, force: true})
})

describe('device cache', () => {
  it('returns undefined for unknown or missing serials', () => {
    expect(getCachedChip('S1')).toBeUndefined()
    expect(getCachedDeviceId('S1')).toBeUndefined()
    expect(getCachedChip(undefined)).toBeUndefined()
  })

  it('records chip and device id for the device at a given path', async () => {
    await rememberDeviceForPort('/dev/a', {chip: 'esp32c6', deviceId: '2m68224yym'})
    expect(getCachedChip('S1')).toBe('esp32c6')
    expect(getCachedDeviceId('S1')).toBe('2m68224yym')
    expect(getCachedChip('S2')).toBeUndefined()
  })

  it('merges facts across connects without dropping prior fields', async () => {
    await rememberDeviceForPort('/dev/a', {chip: 'esp32c6'})
    await rememberDeviceForPort('/dev/a', {deviceId: '2m68224yym'})
    expect(getCachedChip('S1')).toBe('esp32c6')
    expect(getCachedDeviceId('S1')).toBe('2m68224yym')
  })

  it('ignores the simulator, missing port, and empty facts', async () => {
    await rememberDeviceForPort('simulator', {chip: 'esp32c6'})
    await rememberDeviceForPort(undefined, {chip: 'esp32c6'})
    await rememberDeviceForPort('/dev/a', {})
    expect(getCachedChip('S1')).toBeUndefined()
  })

  it('does nothing when no connected device matches the path', async () => {
    await rememberDeviceForPort('/dev/missing', {chip: 'esp32c6'})
    expect(getCachedChip('S1')).toBeUndefined()
  })

  it('tolerates a malformed cache file', () => {
    writeFileSync(deviceCacheFilePath(), 'not json{')
    expect(getCachedChip('S1')).toBeUndefined()
  })
})
