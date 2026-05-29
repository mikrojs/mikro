import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import * as pathlib from 'node:path'

import type {MikroEnv, MikroJSConfig} from '../../_exports/index.js'

/**
 * Resolve the config for `env`: the base config (every field except `env`)
 * shallow-merged with its `env[env]` overrides, with the `env` map stripped.
 * The merge is shallow — each field in the override replaces the base value
 * wholesale, so an override can't leave stray fields behind. Returns null
 * only when no config file was found.
 */
export function resolveConfig(config: MikroJSConfig | null, env: MikroEnv): MikroJSConfig | null {
  if (config === null) return null
  const {env: overrides, ...base} = config
  const override = overrides?.[env]
  return override ? {...base, ...override} : base
}

/**
 * Walk up from `startDir` looking for `mikro.config.ts`. Returns the config
 * resolved for `env` (TS types stripped, `defineConfig` shimmed) or `null` if
 * none found. Defaults to `production` so a bare lookup yields the shipped
 * config.
 */
export async function loadMikroConfig(
  startDir: string,
  env: MikroEnv = 'production',
): Promise<MikroJSConfig | null> {
  let dir = pathlib.resolve(startDir)
  const root = pathlib.parse(dir).root
  while (dir !== root) {
    const configPath = pathlib.join(dir, 'mikro.config.ts')
    if (existsSync(configPath)) {
      const source = await readFile(configPath, 'utf-8')
      let code = stripTypeScriptTypes(source, {mode: 'strip'})
      // Backstop for the no-device-imports-in-config lint rule: device modules
      // (mikrojs/*) can't resolve from a data: URL anyway, so fail with a
      // clear message instead of an opaque module-not-found error.
      const deviceImports = [...code.matchAll(/['"](mikrojs\/[^'"]+)['"]/g)].map((m) => m[1])
      if (deviceImports.length > 0) {
        const unique = [...new Set(deviceImports)]
        throw new Error(
          `${configPath}: cannot import on-device modules (${unique.join(', ')}) in a build-time config file. ` +
            `Only the bare 'mikrojs' import is allowed here; mikrojs/* subpaths are device-only.`,
        )
      }
      code = code.replace(
        /import\s*\{[^}]*\}\s*from\s*['"]mikrojs['"]\s*;?/,
        'const defineConfig = (c) => c;',
      )
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
      const mod = await import(dataUrl)
      return resolveConfig(mod.default as MikroJSConfig, env)
    }
    dir = pathlib.dirname(dir)
  }
  return null
}
