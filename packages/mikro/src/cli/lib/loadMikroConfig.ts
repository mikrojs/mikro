import {existsSync, readFileSync, statSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import * as pathlib from 'node:path'
import {pathToFileURL} from 'node:url'

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
 * Prepare stripped config code for evaluation from a data: URL, which has no
 * module-resolution context of its own:
 *
 * - The bare `mikro` import becomes a local `defineConfig` shim.
 * - `mikro/schema` (the one importable device module: it has a host
 *   implementation, so a config can build its `configSchema`) is rewritten to
 *   `schemaUrl`, the CLI's resolved location of that implementation.
 * - Relative imports (the app's own schema module, typically) are resolved
 *   against `dir`, with a `.js` specifier falling back to the `.ts` source
 *   when only that exists, matching how app imports are written.
 * - Any other mikro/* import is rejected with a clear message: the backstop
 *   for the no-device-imports-in-config lint rule.
 */
export function rewriteConfigImports(
  code: string,
  dir: string,
  configPath: string,
  schemaUrl: string,
): string {
  const deviceImports = [...code.matchAll(/['"](mikro\/[^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'mikro/schema')
  if (deviceImports.length > 0) {
    const unique = [...new Set(deviceImports)]
    throw new Error(
      `${configPath}: cannot import on-device modules (${unique.join(', ')}) in a build-time config file. ` +
        `Only 'mikro' and 'mikro/schema' are importable here; other mikro/* subpaths are device-only.`,
    )
  }
  code = code.replace(
    /import\s*\{[^}]*\}\s*from\s*['"]mikro['"]\s*;?/,
    'const defineConfig = (c) => c;',
  )
  code = code.replaceAll("'mikro/schema'", `'${schemaUrl}'`)
  code = code.replaceAll('"mikro/schema"', `'${schemaUrl}'`)
  code = code.replace(/(from\s*)['"](\.\.?\/[^'"]+)['"]/g, (match, from: string, spec: string) => {
    let target = pathlib.resolve(dir, spec)
    if (!existsSync(target) && spec.endsWith('.js')) {
      const ts = target.slice(0, -3) + '.ts'
      if (existsSync(ts)) target = ts
    }
    // ESM caches modules by URL for the process lifetime, and `mikro dev`
    // re-loads the config on every sync: a bare file:// URL would pin the
    // first version of the imported module (the app's schema, typically) for
    // the whole session. The version query spans the target's transitive
    // relative imports, or an edit two files down (a constants module the
    // schema re-exports from) would stay stale until the session restarts.
    return `${from}'${pathToFileURL(target).href}?v=${treeVersion(target)}'`
  })
  return code
}

/* Newest mtime across `target` and its transitive relative imports, with the
 * same .js-to-.ts fallback the rewrite applies. Non-relative imports are
 * package code the session does not edit; unreadable files count as 0 and
 * fail later, at import, where the error names the module. */
function treeVersion(target: string, seen = new Set<string>()): number {
  if (seen.has(target)) return 0
  seen.add(target)
  if (!existsSync(target)) return 0
  let newest = statSync(target).mtimeMs
  const source = readFileSync(target, 'utf-8')
  for (const match of source.matchAll(/from\s*['"](\.\.?\/[^'"]+)['"]/g)) {
    let dep = pathlib.resolve(pathlib.dirname(target), match[1]!)
    if (!existsSync(dep) && dep.endsWith('.js')) {
      const ts = dep.slice(0, -3) + '.ts'
      if (existsSync(ts)) dep = ts
    }
    newest = Math.max(newest, treeVersion(dep, seen))
  }
  return newest
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
      const stripped = stripTypeScriptTypes(source, {mode: 'strip'})
      const code = rewriteConfigImports(
        stripped,
        dir,
        configPath,
        import.meta.resolve('mikro/schema'),
      )
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
      const mod = await import(dataUrl)
      return resolveConfig(mod.default as MikroJSConfig, env)
    }
    dir = pathlib.dirname(dir)
  }
  return null
}
