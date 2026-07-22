import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import * as pathlib from 'node:path'

import {resolveProjectRoot} from './projectRoot.js'

/** Environment variable read for the registry token when --token is not passed. */
export const TOKEN_ENV = 'MIKRO_OTA_TOKEN'

/** Basename of the registry config file, under `.mikro/`. */
export const REGISTRY_FILE = 'registry.json'

export interface RegistryConnection {
  url?: string
  token?: string
}

/** Read one connection file; missing file is `{}`, malformed JSON throws. */
export function readRegistryFile(path: string): RegistryConnection {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (readError) {
    // Only "not there" is a normal outcome. Anything else (EACCES on a file the
    // user did configure) must not masquerade as "no registry configured".
    if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError
    return {}
  }
  let parsed: {url?: unknown; token?: unknown}
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
  const connection: RegistryConnection = {}
  if (typeof parsed.url === 'string' && parsed.url.length > 0) connection.url = parsed.url
  if (typeof parsed.token === 'string' && parsed.token.length > 0) connection.token = parsed.token
  return connection
}

/** True when two configured urls name the same registry (origin + path). */
function sameRegistry(a: string, b: string): boolean {
  const normalize = (raw: string): string => {
    try {
      const parsed = new URL(raw)
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
    } catch {
      return raw.replace(/\/+$/, '')
    }
  }
  return normalize(a) === normalize(b)
}

/**
 * Resolve the registry config: flags > MIKRO_OTA_TOKEN (token only) >
 * the project's `.mikro/registry.json` > `~/.mikro/registry.json`. The files
 * are admin config (like `.vercel/` or `.npmrc`): gitignored with the
 * rest of `.mikro`, set once per project or per machine.
 *
 * A stored token is only ever paired with the registry it was stored against.
 * Resolving url and token independently would let a project file naming a local
 * dev registry pick up the user-level production token and post it there; the
 * same goes for `--registry <anywhere>`. Only `--token` and MIKRO_OTA_TOKEN
 * cross that line, because both are the caller saying so explicitly.
 */
export function resolveRegistryConnection(
  flags: {registry?: string; token?: string},
  overrides?: {projectFile?: string; userFile?: string; env?: NodeJS.ProcessEnv},
): RegistryConnection {
  const projectPath =
    overrides?.projectFile ?? pathlib.join(resolveProjectRoot(), '.mikro', REGISTRY_FILE)
  const userPath = overrides?.userFile ?? pathlib.join(homedir(), '.mikro', REGISTRY_FILE)
  const env = overrides?.env ?? process.env

  const user = readRegistryFile(userPath)
  const project = readRegistryFile(projectPath)

  const connection: RegistryConnection = {}
  const url = flags.registry ?? project.url ?? user.url
  let token = flags.token ?? env[TOKEN_ENV]
  if (token === undefined && url !== undefined) {
    const stored = [project, user].find(
      (file) => file.url !== undefined && file.token !== undefined && sameRegistry(file.url, url),
    )
    token = stored?.token
  }
  if (url !== undefined) connection.url = url
  if (token !== undefined && token !== '') connection.token = token
  return connection
}

/** The url, or a pointed error naming the ways to provide one. */
export function requireRegistryUrl(connection: RegistryConnection): string {
  if (connection.url === undefined) {
    throw new Error(`No registry configured. Run \`mikro ota setup\`, or pass --registry.`)
  }
  return connection.url
}

/** The token, or a pointed error naming the ways to provide one. */
export function requireRegistryToken(connection: RegistryConnection): string {
  if (connection.token === undefined) {
    throw new Error(
      `Missing registry token. Run \`mikro ota setup\`, pass --token, or set ${TOKEN_ENV}.`,
    )
  }
  return connection.token
}
