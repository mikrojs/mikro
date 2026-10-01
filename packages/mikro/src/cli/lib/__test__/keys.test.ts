import {describe, expect, test} from 'vitest'

import {isExitByte, isExitKey, isKey, KEYS, plainKey, replKeysHelp} from '../keys.js'

describe('keys', () => {
  test('a binding needs Ctrl', () => {
    expect(isKey('restart', 'r', {ctrl: true})).toBe(true)
    expect(isKey('restart', 'r', {})).toBe(false)
    expect(isKey('restart', 's', {ctrl: true})).toBe(false)
  })

  test('Ctrl+S is deploy with or without Shift, and a full deploy only with it', () => {
    expect(isKey('deploy', 's', {ctrl: true})).toBe(true)
    expect(isKey('deploy', 's', {ctrl: true, shift: true})).toBe(true)
    expect(isKey('fullDeploy', 's', {ctrl: true})).toBe(false)
    expect(isKey('fullDeploy', 's', {ctrl: true, shift: true})).toBe(true)
    // As a terminal that reports the shifted letter sends it
    expect(isKey('fullDeploy', 'S', {ctrl: true, shift: true})).toBe(true)
  })

  test('Ctrl+C, Ctrl+D and Ctrl+Q are the exit keys', () => {
    for (const ch of ['c', 'd', 'q']) {
      expect(isExitKey(ch, {ctrl: true}), ch).toBe(true)
      expect(isExitKey(ch, {}), ch).toBe(false)
    }
    expect(isExitKey('r', {ctrl: true})).toBe(false)
  })

  test('the exit keys as a raw terminal sends them', () => {
    for (const byte of ['\x03', '\x04', '\x11']) expect(isExitByte(byte)).toBe(true)
    expect(isExitByte('\x12')).toBe(false)
    expect(isExitByte('c')).toBe(false)
    // A paste that happens to start with one is not a key press
    expect(isExitByte('\x03abc')).toBe(false)
  })

  test('a letter typed with Ctrl or Alt is not that letter', () => {
    expect(plainKey('d', {})).toBe('d')
    expect(plainKey('d', {ctrl: true})).toBe('')
    expect(plainKey('d', {meta: true})).toBe('')
  })

  test('no two bindings share a key, apart from Shift', () => {
    const seen = Object.values(KEYS).map((b) => `${'shift' in b ? 'shift+' : ''}${b.ch}`)
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('/help lists the keys of the REPL, one per line', () => {
    const lines = replKeysHelp(true).split('\n')
    expect(lines).toContain('Ctrl+R        Restart the device')
    expect(lines).toContain('Ctrl+S        Deploy what changed')
    expect(lines).toContain('Ctrl+Shift+S  Deploy every file again (where supported)')
    // Ctrl+U works in the env editor only
    expect(lines.join()).not.toContain('Ctrl+U')
  })

  test('/help leaves out the deploy keys where Ctrl+S does not deploy', () => {
    const lines = replKeysHelp(false).split('\n')
    expect(lines.join()).not.toContain('Ctrl+S')
    expect(lines).toContain('Ctrl+R  Restart the device')
  })
})
