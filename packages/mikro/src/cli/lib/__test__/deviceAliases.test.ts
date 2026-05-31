import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Redirect to a throwaway temp dir. matchPortToken reaches into the device
// cache, so config and cache both resolve to the same dir.
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

const {
  deviceAliasesFilePath,
  deviceDisplayName,
  getDeviceAlias,
  matchPortToken,
  readDeviceAliases,
  removeDeviceAlias,
  setDeviceAlias,
} = await import('../deviceAliases.js')

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'mikro-aliases-'))
})

afterEach(() => {
  rmSync(state.dir, {recursive: true, force: true})
})

describe('device aliases', () => {
  it('sets and reads an alias by serial number', () => {
    expect(setDeviceAlias('S1', 'kitchen-sensor')).toEqual({ok: true})
    expect(getDeviceAlias('S1')).toBe('kitchen-sensor')
    expect(readDeviceAliases()).toEqual({S1: 'kitchen-sensor'})
  })

  it('returns undefined for unknown or missing serials', () => {
    expect(getDeviceAlias('nope')).toBeUndefined()
    expect(getDeviceAlias(undefined)).toBeUndefined()
  })

  it('allows renaming the same serial', () => {
    setDeviceAlias('S1', 'old')
    expect(setDeviceAlias('S1', 'new')).toEqual({ok: true})
    expect(getDeviceAlias('S1')).toBe('new')
  })

  it('rejects a name already used by a different serial', () => {
    setDeviceAlias('S1', 'kitchen')
    const result = setDeviceAlias('S2', 'kitchen')
    expect(result.ok).toBe(false)
    expect(getDeviceAlias('S2')).toBeUndefined()
  })

  it('rejects empty and malformed names', () => {
    expect(setDeviceAlias('S1', '   ').ok).toBe(false)
    expect(setDeviceAlias('S1', 'has space').ok).toBe(false)
    expect(setDeviceAlias('S1', '/dev/tty').ok).toBe(false)
    expect(setDeviceAlias('S1', '-leading-dash').ok).toBe(false)
    expect(readDeviceAliases()).toEqual({})
  })

  it('removes an alias by name or by serial', () => {
    setDeviceAlias('S1', 'kitchen')
    setDeviceAlias('S2', 'garage')
    expect(removeDeviceAlias('kitchen')).toEqual({ok: true})
    expect(removeDeviceAlias('S2')).toEqual({ok: true})
    expect(readDeviceAliases()).toEqual({})
  })

  it('reports when there is no alias to remove', () => {
    expect(removeDeviceAlias('nope').ok).toBe(false)
  })

  it('tolerates a missing or malformed file', () => {
    expect(readDeviceAliases()).toEqual({})
    writeFileSync(deviceAliasesFilePath(), 'not json{')
    expect(readDeviceAliases()).toEqual({})
  })

  it('drops hand-edited names that fail validation', () => {
    writeFileSync(
      deviceAliasesFilePath(),
      JSON.stringify({S1: 'ok-name', S2: 'has space', S3: 'evil[2J', S4: 'a'.repeat(65)}),
    )
    expect(readDeviceAliases()).toEqual({S1: 'ok-name'})
  })

  describe('deviceDisplayName', () => {
    it('returns the alias when one is set', () => {
      setDeviceAlias('S1', 'kitchen')
      expect(deviceDisplayName('S1')).toBe('kitchen')
    })

    it('returns a suggested name for an unaliased device', () => {
      const name = deviceDisplayName('543204227bd4')
      expect(name).toMatch(/^[a-z]+-[a-z]+$/)
      expect(name).not.toBe('(unknown)')
    })

    it('falls back to "(unknown)" with no serial to seed from', () => {
      expect(deviceDisplayName(undefined)).toBe('(unknown)')
    })

    it('seeds the suggestion from the live device id when no serial', () => {
      const name = deviceDisplayName(undefined, '2m68224yym')
      expect(name).toMatch(/^[a-z]+-[a-z]+$/)
    })
  })

  describe('matchPortToken', () => {
    const devices = [
      {path: '/dev/a', serialNumber: 'S1'},
      {path: '/dev/b', serialNumber: 'S2'},
    ]

    it('matches by exact path', () => {
      expect(matchPortToken(devices, '/dev/b')?.serialNumber).toBe('S2')
    })

    it('matches by alias name', () => {
      setDeviceAlias('S1', 'kitchen')
      expect(matchPortToken(devices, 'kitchen')?.path).toBe('/dev/a')
    })

    it('matches by raw serial number', () => {
      expect(matchPortToken(devices, 'S2')?.path).toBe('/dev/b')
    })

    it('matches by the derived device id when the serial is a MAC', () => {
      const macDevices = [{path: '/dev/c', serialNumber: '54:32:04:22:7B:D4'}]
      expect(matchPortToken(macDevices, '2m68224yym')?.path).toBe('/dev/c')
    })

    it('returns undefined when nothing matches', () => {
      expect(matchPortToken(devices, 'unknown')).toBeUndefined()
    })
  })
})
