import {existsSync, readFileSync} from 'node:fs'
import * as pathlib from 'node:path'

/**
 * Resolve the entry file for a command.
 * If an explicit entry is provided, return it as-is.
 * Otherwise, read the `main` field from the nearest `package.json`.
 */
export function resolveEntry(entry: string | undefined): string {
  if (entry !== undefined) {
    return entry
  }

  const cwd = process.cwd()
  const pkgPath = pathlib.join(cwd, 'package.json')

  if (!existsSync(pkgPath)) {
    throw new Error(
      `No entry file specified and no package.json found in ${cwd}.\n` +
        `Either pass an entry file (e.g. mikro dev app/main.ts) or add a "main" field to package.json.`,
    )
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const main = pkg.main

  if (typeof main !== 'string') {
    throw new Error(
      `No entry file specified and package.json has no "main" field.\n` +
        `Either pass an entry file (e.g. mikro dev app/main.ts) or add a "main" field to package.json.`,
    )
  }

  const resolved = pathlib.resolve(cwd, main)

  if (!existsSync(resolved)) {
    throw new Error(
      `Entry file "${main}" (from package.json "main" field) does not exist: ${resolved}`,
    )
  }

  return pathlib.relative(cwd, resolved)
}
