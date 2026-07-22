import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Redirect to a throwaway temp dir. Names live in the device cache, so config
// and cache both resolve to the same dir.
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
  decodeDeviceName,
  deviceDisplayName,
  deviceGeneratedName,
  encodeDeviceName,
  matchPortToken,
  validateDeviceName,
} = await import('../deviceName.js')
const {deviceCacheFilePath, getCachedName} = await import('../deviceCache.js')

/** Seed the cache the way a connect handshake would. */
function cacheName(serial: string, name: string, deviceId?: string) {
  writeFileSync(deviceCacheFilePath(), JSON.stringify({[serial]: {name, deviceId}}))
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'mikro-names-'))
})

afterEach(() => {
  rmSync(state.dir, {recursive: true, force: true})
})

describe('name pair encoding', () => {
  it('round-trips a name and its revision', () => {
    const encoded = encodeDeviceName({rev: 3, name: 'kitchen'})
    expect(decodeDeviceName(encoded)).toEqual({rev: 3, name: 'kitchen'})
  })

  it('keeps the revision when the name is cleared, so the clear propagates', () => {
    const encoded = encodeDeviceName({rev: 4})
    expect(JSON.parse(encoded)).toEqual([4])
    expect(decodeDeviceName(encoded)).toEqual({rev: 4, name: undefined})
  })

  it('treats a missing value as never named', () => {
    expect(decodeDeviceName(undefined)).toEqual({rev: 0, name: undefined})
  })

  // Unreadable bytes and never-named share a shape, so they are separated by a
  // flag rather than by the revision. Collapsing them lets a re-seed overwrite
  // a name that is really set, at a revision that then loses to the registry.
  it('flags present-but-unreadable values as corrupt, not as never named', () => {
    for (const raw of [
      'not json{',
      '{"rev":1}',
      '["1","kitchen"]',
      '[-1,"kitchen"]',
      'null',
      '[]',
    ]) {
      expect(decodeDeviceName(raw)).toEqual({rev: 0, name: undefined, corrupt: true})
    }
  })

  it('accepts a non-integer revision as corrupt rather than truncating it', () => {
    expect(decodeDeviceName('[1.5,"kitchen"]').corrupt).toBe(true)
  })

  // Rule 4a: a cleared name at a live revision must keep that revision, or the
  // clear cannot outrank the registry's copy of the old name.
  it('keeps the revision of a cleared name and does not call it corrupt', () => {
    expect(decodeDeviceName('[3,""]')).toEqual({rev: 3, name: undefined})
    expect(decodeDeviceName('[3,""]').corrupt).toBeUndefined()
  })

  // A non-string name at a valid revision is the registry's "cleared" encoding
  // seen through a lenient parser; the revision is still readable and is what
  // arbitration needs, so it survives.
  it('keeps a readable revision even when the name element is unusable', () => {
    expect(decodeDeviceName('[3,42]')).toEqual({rev: 3, name: undefined})
  })
})

describe('validateDeviceName', () => {
  it('accepts a plain name', () => {
    expect(validateDeviceName('kitchen-sensor')).toEqual({ok: true})
  })

  it('rejects empty and malformed names', () => {
    expect(validateDeviceName('').ok).toBe(false)
    expect(validateDeviceName('has space').ok).toBe(false)
    expect(validateDeviceName('/dev/tty').ok).toBe(false)
    expect(validateDeviceName('-leading-dash').ok).toBe(false)
    expect(validateDeviceName('evil[2J').ok).toBe(false)
    expect(validateDeviceName('a'.repeat(65)).ok).toBe(false)
  })

  it('rejects punctuation outside the allowed set', () => {
    expect(validateDeviceName('a:b').ok).toBe(false)
    expect(validateDeviceName('a/b').ok).toBe(false)
  })
})

describe('deviceGeneratedName', () => {
  it('is a provisioning seed only, never what gets displayed', () => {
    const seed = deviceGeneratedName('543204227bd4')
    expect(seed).toMatch(/^[a-z]+-[a-z]+$/)
    // Nothing displays it: an unnamed device shows its id, a named one its name.
    expect(deviceDisplayName('543204227bd4')).toBe('2m68224yym')
    cacheName('543204227bd4', 'kitchen')
    expect(deviceGeneratedName('543204227bd4')).toBe(seed)
    expect(deviceDisplayName('543204227bd4')).toBe('kitchen')
  })

  it('is undefined when there is nothing to seed from', () => {
    expect(deviceGeneratedName(undefined)).toBeUndefined()
  })
})

describe('deviceDisplayName', () => {
  it('returns the name the device reported for itself', () => {
    cacheName('S1', 'kitchen')
    expect(getCachedName('S1')).toBe('kitchen')
    expect(deviceDisplayName('S1')).toBe('kitchen')
  })

  it('falls back to the device id, not a derived name, when none is set', () => {
    // A derived name would change under a CLI upgrade; the id is real and stable.
    expect(deviceDisplayName('543204227bd4')).toBe('2m68224yym')
  })

  it('falls back to "(unknown)" with no serial to seed from', () => {
    expect(deviceDisplayName(undefined)).toBe('(unknown)')
  })

  it('uses the live device id when there is no serial', () => {
    expect(deviceDisplayName(undefined, '2m68224yym')).toBe('2m68224yym')
  })

  it('finds a name by device id when the caller has no serial', () => {
    cacheName('S1', 'kitchen', '2m68224yym')
    expect(deviceDisplayName(undefined, '2m68224yym')).toBe('kitchen')
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

  it('matches by the device name', () => {
    cacheName('S1', 'kitchen')
    expect(matchPortToken(devices, 'kitchen')?.path).toBe('/dev/a')
  })

  it('matches by raw serial number', () => {
    expect(matchPortToken(devices, 'S2')?.path).toBe('/dev/b')
  })

  it('matches by the derived device id when the serial is a MAC', () => {
    const macDevices = [{path: '/dev/c', serialNumber: '54:32:04:22:7B:D4'}]
    expect(matchPortToken(macDevices, '2m68224yym')?.path).toBe('/dev/c')
  })

  it('never matches a derived name, only real identifiers', () => {
    const macDevices = [{path: '/dev/c', serialNumber: '543204227bd4'}]
    const generated = deviceGeneratedName('543204227bd4')!
    expect(matchPortToken(macDevices, generated)).toBeUndefined()
    // The device id is what actually resolves it.
    expect(matchPortToken(macDevices, '2m68224yym')?.path).toBe('/dev/c')
  })

  it('matches a set name once the device reports one', () => {
    const macDevices = [{path: '/dev/c', serialNumber: '543204227bd4'}]
    cacheName('543204227bd4', 'kitchen')
    expect(matchPortToken(macDevices, 'kitchen')?.path).toBe('/dev/c')
  })

  it('returns undefined when nothing matches', () => {
    expect(matchPortToken(devices, 'unknown')).toBeUndefined()
  })
})
