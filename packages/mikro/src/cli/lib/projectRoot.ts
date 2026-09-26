import {existsSync, mkdirSync} from 'node:fs'
import * as pathlib from 'node:path'

/**
 * Walk up from `from` (default cwd) looking for package.json or mikro.config.ts.
 * Returns the directory containing the first match, or `from` as fallback.
 */
export function resolveProjectRoot(from = process.cwd()): string {
  let dir = from
  const root = pathlib.parse(dir).root

  while (dir !== root) {
    if (existsSync(pathlib.join(dir, 'package.json'))) return dir
    if (existsSync(pathlib.join(dir, 'mikro.config.ts'))) return dir
    dir = pathlib.dirname(dir)
  }

  return from
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

/** Scratch build directory for `mikro dev`, `mikro test` and the `sim` commands,
 *  apart from `mikro build`'s `.mikro/build`. */
export function getDevBuildDir(): string {
  return pathlib.join(getMikroDir(), 'build-dev')
}
