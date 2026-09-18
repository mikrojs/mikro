import modulesJson from '@mikrojs/native/runtime/modules.json' with {type: 'json'}
import {describe, expect, it} from 'vitest'

import {builtinModuleNames} from '../builtins/index.js'

// The sim keeps hand-written maps; this pins them to the capability table so
// they can't silently drift when a native module is renamed or removed.
describe('builtinModuleNames', () => {
  const nativeIds = new Set(
    modulesJson.modules
      .map((m) => ('native' in m ? m.native : undefined))
      .filter((n) => n !== undefined),
  )
  const moduleNames = new Set(modulesJson.modules.map((m) => m.name))

  for (const [name, specifier] of Object.entries(builtinModuleNames)) {
    it(`${name} → ${specifier} exists in modules.json`, () => {
      if (name === 'console') {
        // console is a native global, not a table module.
        expect(specifier).toBe('native:console')
        return
      }
      if (specifier.startsWith('native:mikro/')) {
        const nativeId = specifier.slice('native:mikro/'.length)
        expect(nativeIds.has(nativeId), `native id '${nativeId}' missing from modules.json`).toBe(
          true,
        )
        return
      }
      // Platform C modules stubbed under their public name (mikro/gpio).
      expect(specifier.startsWith('mikro/'), specifier).toBe(true)
      const moduleName = specifier.slice('mikro/'.length)
      expect(moduleNames.has(moduleName), `module '${moduleName}' missing from modules.json`).toBe(
        true,
      )
    })
  }
})
