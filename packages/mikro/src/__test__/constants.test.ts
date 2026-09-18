import modulesJson from '@mikrojs/native/runtime/modules.json' with {type: 'json'}
import {describe, expect, it} from 'vitest'

import {isBuiltinModule} from '../constants.js'

describe('isBuiltinModule', () => {
  it('treats any native: specifier as a builtin', () => {
    // `native:` is a firmware-only scheme that never resolves to a file on disk,
    // so the tracer must always skip it — including app-local native modules.
    expect(isBuiltinModule('native:mikro/sleep')).toBe(true)
    expect(isBuiltinModule('native:mikrobird/melspec')).toBe(true)
    expect(isBuiltinModule('native:console')).toBe(true)
  })

  it('matches mikro/<name> for every capability-table module', () => {
    expect(isBuiltinModule('mikro')).toBe(true)
    for (const mod of modulesJson.modules) {
      expect(isBuiltinModule(`mikro/${mod.name}`), mod.name).toBe(true)
    }
  })

  it('matches internal (non-public) table modules', () => {
    // The on-device loader resolves internal builtins too, so the tracer
    // must skip them even though they have no mikro/* export subpath.
    expect(isBuiltinModule('mikro/abort')).toBe(true)
    expect(isBuiltinModule('mikro/kv/shared')).toBe(true)
  })

  it('does not match mikro/* names missing from the table', () => {
    expect(isBuiltinModule('mikro/fetch')).toBe(false)
    expect(isBuiltinModule('mikro/wify')).toBe(false)
  })

  it('does not match ordinary specifiers', () => {
    expect(isBuiltinModule('react')).toBe(false)
    expect(isBuiltinModule('fetch')).toBe(false)
    expect(isBuiltinModule('@mikrojs/some-board')).toBe(false)
    expect(isBuiltinModule('./local.js')).toBe(false)
  })
})
