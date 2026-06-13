import {describe, expect, it} from 'vitest'

import {isBuiltinModule} from '../constants.js'

describe('isBuiltinModule', () => {
  it('treats any native: specifier as a builtin', () => {
    // `native:` is a firmware-only scheme that never resolves to a file on disk,
    // so the tracer must always skip it — including app-local native modules.
    expect(isBuiltinModule('native:mikro/pin')).toBe(true)
    expect(isBuiltinModule('native:mikrobird/melspec')).toBe(true)
    expect(isBuiltinModule('native:console')).toBe(true)
  })

  it('matches core mikro builtins', () => {
    expect(isBuiltinModule('mikro')).toBe(true)
    expect(isBuiltinModule('mikro/wifi')).toBe(true)
    expect(isBuiltinModule('fetch')).toBe(true)
  })

  it('does not match ordinary specifiers', () => {
    expect(isBuiltinModule('react')).toBe(false)
    expect(isBuiltinModule('@mikrojs/some-board')).toBe(false)
    expect(isBuiltinModule('./local.js')).toBe(false)
  })
})
