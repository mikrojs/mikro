import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import * as pathlib from 'node:path'

import {builtinModuleNames, type BuiltinName} from './builtins/index.js'

/**
 * Load user-provided sim stubs from the `sim/` directory.
 *
 * Each `sim/<name>.stub.ts` file is a JS/TS module that directly implements
 * the corresponding `native:*` native module. The source is read as text,
 * TypeScript types are stripped, and the result is registered as a virtual
 * module in the QuickJS runtime (replacing the native C module).
 *
 * Stubs run inside QuickJS, not in Node.js. They should export the same
 * interface as the native module they replace.
 *
 * Returns a map of native:* module name → source string.
 */
export function loadSimStubs(projectDir: string): Record<string, string> {
  const simDir = pathlib.join(projectDir, 'sim')
  if (!existsSync(simDir)) return {}

  const validNames = new Set(Object.keys(builtinModuleNames))
  const sources: Record<string, string> = {}

  for (const file of readdirSync(simDir)) {
    if (!file.endsWith('.stub.ts') && !file.endsWith('.stub.js')) continue

    const name = file.replace(/\.stub\.[tj]s$/, '')
    if (!validNames.has(name)) continue

    const moduleName = builtinModuleNames[name as BuiltinName]
    if (!moduleName) continue

    const filePath = pathlib.join(simDir, file)
    const source = readStubSource(filePath)

    // Detect old-format stubs (export default { methods: { ... } })
    if (source.includes('export default') && source.includes('methods')) {
      process.stderr.write(
        `Warning: sim/${file} uses the old stub format (export default { methods }).\n` +
          `Run \`mikro sim scaffold --overwrite\` to update it.\n`,
      )
      continue
    }

    sources[moduleName] = source
  }

  return sources
}

function readStubSource(filePath: string): string {
  let code = readFileSync(filePath, 'utf-8')

  if (filePath.endsWith('.ts')) {
    code = stripTypeScriptTypes(code, {mode: 'strip'})
  }

  // Strip type-only imports (they erase to empty import statements)
  code = code.replace(/import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"]\s*;?/g, '')

  return code
}
