import {existsSync, mkdirSync} from 'node:fs'
import * as pathlib from 'node:path'

/**
 * Walk up from cwd looking for package.json or mikro.config.ts.
 * Returns the directory containing the first match, or cwd as fallback.
 */
export function resolveProjectRoot(): string {
  let dir = process.cwd()
  const root = pathlib.parse(dir).root

  while (dir !== root) {
    if (existsSync(pathlib.join(dir, 'package.json'))) return dir
    if (existsSync(pathlib.join(dir, 'mikro.config.ts'))) return dir
    dir = pathlib.dirname(dir)
  }

  return process.cwd()
}

/**
 * Return the path to the .mikro/ directory in the project root,
 * creating it if it doesn't exist.
 */
export function getMikroDir(): string {
  const dir = pathlib.join(resolveProjectRoot(), '.mikro')
  mkdirSync(dir, {recursive: true})
  return dir
}
