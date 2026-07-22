import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Redirect the cache file to a throwaway temp dir.
const state = vi.hoisted(() => ({dir: ''}))
vi.mock('../envPaths.js', () => ({
  paths: {
    get config() {
      return state.dir
    },
    get cache() {
      return state.dir
    },
  },
}))

const {deviceCacheFilePath} = await import('../deviceCache.js')

/** Seed the cache the way a connect handshake would. */
function cacheName(serial: string, name: string) {
  writeFileSync(deviceCacheFilePath(), JSON.stringify({[serial]: {name}}))
}
const {deviceLabel, formatDeviceList} = await import('../deviceLabel.js')

// 543204227bd4 derives to this id (cross-checked against the firmware encoding).
const MAC = '543204227bd4'
const MAC_ID = '2m68224yym'

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'mikro-label-'))
})

afterEach(() => {
  rmSync(state.dir, {recursive: true, force: true})
})

describe('deviceLabel', () => {
  it('uses the device name when one is set', () => {
    cacheName(MAC, 'kitchen')
    // Chip is unknown until a connect, so it's omitted (id only).
    expect(deviceLabel({path: '/dev/a', serialNumber: MAC})).toBe(`kitchen (id=${MAC_ID})`)
  })

  it('shows the device id when unnamed, without repeating it as meta', () => {
    expect(deviceLabel({path: '/dev/a', serialNumber: MAC})).toBe(MAC_ID)
  })

  it('uses a cached chip and device id when present', () => {
    writeFileSync(
      deviceCacheFilePath(),
      JSON.stringify({BRIDGE: {chip: 'esp32c6', deviceId: 'abcde12345'}}),
    )
    // Unnamed, so the cached id is the display name and only the chip remains.
    expect(deviceLabel({path: '/dev/a', serialNumber: 'BRIDGE'})).toBe('abcde12345 (chip=esp32c6)')
  })

  it('falls back to the raw serial as the id when none is derivable or cached', () => {
    // Nothing derivable, so the serial itself is both the name and the id.
    expect(deviceLabel({path: '/dev/a', serialNumber: 'NOTAMAC'})).toBe('NOTAMAC')
  })
})

describe('formatDeviceList', () => {
  it('renders "name path (chip=…, id=…)" with aligned columns', () => {
    cacheName(MAC, 'kitchen')
    const lines = formatDeviceList([
      {path: '/dev/a', serialNumber: MAC},
      {path: '/dev/longerpath', serialNumber: '001122334455'},
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(new RegExp(`^kitchen\\s+/dev/a\\s+\\(id=${MAC_ID}\\)$`))
    // The path column starts at the same offset on every row.
    expect(lines[0]!.indexOf('/dev/')).toBe(lines[1]!.indexOf('/dev/'))
  })
})
