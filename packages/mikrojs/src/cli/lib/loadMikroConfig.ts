import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import * as pathlib from 'node:path'

import type {MikroJSConfig} from '../../_exports/index.js'

/**
 * Walk up from `startDir` looking for `mikro.config.ts`. Returns the parsed
 * config (TS types stripped, `defineConfig` shimmed) or `null` if none found.
 */
export async function loadMikroConfig(startDir: string): Promise<MikroJSConfig | null> {
  let dir = pathlib.resolve(startDir)
  const root = pathlib.parse(dir).root
  while (dir !== root) {
    const configPath = pathlib.join(dir, 'mikro.config.ts')
    if (existsSync(configPath)) {
      const source = await readFile(configPath, 'utf-8')
      let code = stripTypeScriptTypes(source, {mode: 'strip'})
      code = code.replace(
        /import\s*\{[^}]*\}\s*from\s*['"]mikrojs['"]\s*;?/,
        'const defineConfig = (c) => c;',
      )
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
      const mod = await import(dataUrl)
      return mod.default as MikroJSConfig
    }
    dir = pathlib.dirname(dir)
  }
  return null
}
