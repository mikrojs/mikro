import * as pathlib from 'node:path'

import {access, readdir, readFile, stat} from 'fs/promises'
import {SerialPort} from 'serialport'

import {parseDotenv} from './dotenv.js'

export const BAUD_RATE = 115200

interface PortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
}

export async function resolvePort(explicit?: string): Promise<string> {
  const devices: PortInfo[] = (await SerialPort.list()).filter((p) => p.serialNumber)

  if (explicit) {
    const match = devices.find((d) => d.path === explicit)
    if (!match) {
      const lines = [`Error: Device not found: ${explicit}`]
      if (devices.length > 0) {
        lines.push('\nConnected devices:')
        for (const d of devices) {
          lines.push(`  ${d.path} (${d.manufacturer ?? ''} ${d.serialNumber ?? ''}`)
        }
      } else {
        lines.push('No devices found')
      }
      throw new Error(lines.join('\n'))
    }
    return match.path
  }

  if (devices.length === 0) {
    throw new Error('No serial devices found')
  }

  if (devices.length === 1) {
    return devices[0]!.path
  }

  const lines = ['Multiple devices found. Use --port to select one:\n']
  for (const d of devices) {
    lines.push(`  ${d.path} (${d.manufacturer ?? ''} ${d.serialNumber ?? ''}`)
  }
  throw new Error(lines.join('\n'))
}

export async function collectFiles(buildDir: string): Promise<{path: string; data: Buffer}[]> {
  const entries = await readdir(buildDir, {recursive: true})
  const files: {path: string; data: Buffer}[] = []

  for (const entry of entries) {
    const full = pathlib.join(buildDir, entry)
    const s = await stat(full)
    if (s.isFile()) {
      files.push({
        path: '/' + entry,
        data: await readFile(full),
      })
    }
  }

  return files
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export interface EnvVar {
  key: string
  value: string
  secret: boolean
}

export interface LoadEnvOptions {
  /** Directory to scan for .env files. */
  cwd: string
  /** Mode name used to discover .env.<mode> (e.g. 'development', 'production', 'test'). */
  mode: string
  /** Explicit --env FILE path (additive, layered after auto-discovery). */
  envFile?: string
  /** When true, skips auto-discovery of .env / .env.<mode>. Explicit files still load. */
  noEnvFile?: boolean
}

async function readDotenvFile(path: string): Promise<EnvVar[]> {
  const content = await readFile(path, 'utf-8')
  return parseDotenv(content).map(({key, value, noSecret}) => ({
    key,
    value,
    secret: !noSecret,
  }))
}

/**
 * Load env vars from .env files with precedence (later overrides earlier):
 *   1. <cwd>/.env                  (auto, skipped when noEnvFile)
 *   2. <cwd>/.env.<mode>           (auto, skipped when noEnvFile)
 *   3. opts.envFile                (explicit --env, error if missing)
 *
 * Auto-discovered files are silently skipped if missing.
 * Returned array is deduped by key with last-wins semantics.
 *
 * Vars are marked secret by default. Add a `# @no-secret` comment line
 * directly above an entry to opt that one var out (visible in `mikro env list`).
 */
export async function loadEnvFiles(opts: LoadEnvOptions): Promise<EnvVar[]> {
  const vars: EnvVar[] = []

  if (!opts.noEnvFile) {
    const base = pathlib.join(opts.cwd, '.env')
    if (await fileExists(base)) {
      vars.push(...(await readDotenvFile(base)))
    }
    const modeFile = pathlib.join(opts.cwd, `.env.${opts.mode}`)
    if (await fileExists(modeFile)) {
      vars.push(...(await readDotenvFile(modeFile)))
    }
  }

  if (opts.envFile) {
    if (!(await fileExists(opts.envFile))) {
      throw new Error(`Env file not found: ${opts.envFile}`)
    }
    vars.push(...(await readDotenvFile(opts.envFile)))
  }

  // Dedup by key, last wins.
  const merged = new Map<string, EnvVar>()
  for (const v of vars) merged.set(v.key, v)
  return Array.from(merged.values())
}

/** Maximum length of an env var name persisted to ESP32 NVS. */
export const NVS_KEY_MAX_LENGTH = 15

/**
 * Validate that all env var keys fit within NVS's name length limit.
 * Throws with a single error listing every violation.
 */
export function validateNvsKeys(vars: EnvVar[]): void {
  const tooLong = vars.filter((v) => v.key.length > NVS_KEY_MAX_LENGTH)
  if (tooLong.length === 0) return

  const lines = [
    `Env var name(s) exceed NVS limit of ${NVS_KEY_MAX_LENGTH} characters:`,
    ...tooLong.map((v) => `  ${v.key} (${v.key.length} chars)`),
  ]
  throw new Error(lines.join('\n'))
}
