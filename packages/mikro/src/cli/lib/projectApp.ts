import {readFileSync} from 'node:fs'
import * as pathlib from 'node:path'

import {resolveProjectRoot} from './projectRoot.js'

/**
 * The project's package.json name, which is the app a registry scopes a token
 * and a device to. Best effort: a project without one just gets no app context,
 * and the registry falls back to pinning a device on its first check-in.
 */
export function readProjectApp(): string | undefined {
  let raw: string
  try {
    raw = readFileSync(pathlib.join(resolveProjectRoot(), 'package.json'), 'utf-8')
  } catch {
    return undefined
  }
  let pkg: {name?: unknown}
  try {
    pkg = JSON.parse(raw) as typeof pkg
  } catch {
    return undefined
  }
  return typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : undefined
}
