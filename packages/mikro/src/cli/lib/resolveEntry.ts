import {existsSync, readFileSync} from 'node:fs'
import * as pathlib from 'node:path'

import {UserError} from './errorMessage.js'

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
    throw new UserError(
      `No entry file specified and no package.json found in ${cwd}.\n` +
        `Either pass an entry file (e.g. mikro dev app/main.ts) or add a "main" field to package.json.`,
    )
  }

  let pkg: {main?: unknown}
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch (err) {
    throw new UserError(`${pkgPath} is not valid JSON`, {cause: err})
  }
  const main = pkg.main

  if (typeof main !== 'string') {
    throw new UserError(
      `No entry file specified and package.json has no "main" field.\n` +
        `Either pass an entry file (e.g. mikro dev app/main.ts) or add a "main" field to package.json.`,
    )
  }

  const resolved = pathlib.resolve(cwd, main)

  if (!existsSync(resolved)) {
    throw new UserError(
      `Entry file "${main}" (from package.json "main" field) does not exist: ${resolved}`,
    )
  }

  return pathlib.relative(cwd, resolved)
}
