import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {getCachedDeviceId} from './deviceCache.js'
import {deviceIdFromSerial} from './deviceId.js'
import {paths} from './envPaths.js'
import {suggestDeviceName} from './suggestName.js'

/**
 * User-editable map of USB serial → friendly name (device-aliases.json in the
 * per-user config dir). Per-user, not per-project, so a board keeps its name
 * everywhere. Keyed by serial because it's stable per device, unlike the
 * OS-assigned path. Hand-editable; also managed via `mikro alias`.
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const NAME_MAX = 64

export type AliasResult = {ok: true} | {ok: false; error: string}

export function deviceAliasesFilePath(): string {
  return join(paths.config, 'device-aliases.json')
}

/** Read the serial→name map. A missing or malformed file yields an empty map. */
export function readDeviceAliases(): Record<string, string> {
  let raw: string
  try {
    raw = readFileSync(deviceAliasesFilePath(), 'utf-8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: Record<string, string> = {}
  for (const [serial, name] of Object.entries(parsed as Record<string, unknown>)) {
    // Re-validate hand-edited entries the same way setDeviceAlias does, so a
    // name carrying control/ANSI chars can't reach the terminal or completions.
    if (typeof name === 'string' && name.length <= NAME_MAX && NAME_RE.test(name)) {
      out[serial] = name
    }
  }
  return out
}

export function getDeviceAlias(serialNumber: string | undefined): string | undefined {
  if (!serialNumber) return undefined
  return readDeviceAliases()[serialNumber]
}

/** Alias for a firmware-reported device id, matched back to an aliased serial
 *  via deviceIdFromSerial — no live USB serial needed. */
export function getDeviceAliasByDeviceId(deviceId: string | null | undefined): string | undefined {
  if (!deviceId) return undefined
  for (const [serial, name] of Object.entries(readDeviceAliases())) {
    if (deviceIdFromSerial(serial) === deviceId) return name
  }
  return undefined
}

/**
 * The board's name: its alias if set, else a stable suggested name (so every
 * identifiable board always has one), else "(unknown)" when there's nothing to
 * seed from. Pass the firmware-reported deviceId (from a live connection) to
 * resolve bridge boards whose serial isn't the chip MAC.
 */
export function deviceDisplayName(
  serialNumber: string | undefined,
  deviceId?: string | null,
): string {
  const alias = getDeviceAlias(serialNumber) ?? getDeviceAliasByDeviceId(deviceId)
  if (alias) return alias
  const seed =
    deviceIdFromSerial(serialNumber) ?? getCachedDeviceId(serialNumber) ?? deviceId ?? serialNumber
  return seed ? suggestDeviceName(seed) : '(unknown)'
}

/** Names must be unique so they can stand in for `--port`. */
export function setDeviceAlias(serialNumber: string, name: string): AliasResult {
  const trimmed = name.trim()
  if (!trimmed) return {ok: false, error: 'Name must not be empty'}
  if (trimmed.length > NAME_MAX) {
    return {ok: false, error: `Name must be ${NAME_MAX} characters or fewer`}
  }
  if (!NAME_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'Name must start with a letter or digit and use only letters, digits, dot, dash, or underscore',
    }
  }
  const aliases = readDeviceAliases()
  for (const [serial, existing] of Object.entries(aliases)) {
    if (serial !== serialNumber && existing === trimmed) {
      return {ok: false, error: `Name "${trimmed}" is already used by serial ${serial}`}
    }
  }
  aliases[serialNumber] = trimmed
  writeDeviceAliases(aliases)
  return {ok: true}
}

/** Remove an alias by name or by serial. */
export function removeDeviceAlias(token: string): AliasResult {
  const aliases = readDeviceAliases()
  let serialToRemove: string | undefined
  if (aliases[token]) {
    serialToRemove = token
  } else {
    for (const [serial, name] of Object.entries(aliases)) {
      if (name === token) {
        serialToRemove = serial
        break
      }
    }
  }
  if (!serialToRemove) return {ok: false, error: `No alias matching "${token}"`}
  const remaining = Object.fromEntries(
    Object.entries(aliases).filter(([serial]) => serial !== serialToRemove),
  )
  writeDeviceAliases(remaining)
  return {ok: true}
}

/** Resolve a `--port` token, in order: exact path, alias name, raw serial,
 *  then derived/cached device id. Undefined if nothing matches. */
export function matchPortToken<T extends {path: string; serialNumber?: string | undefined}>(
  devices: T[],
  token: string,
): T | undefined {
  const byPath = devices.find((d) => d.path === token)
  if (byPath) return byPath

  const aliases = readDeviceAliases()
  const serialForName = Object.keys(aliases).find((serial) => aliases[serial] === token)
  if (serialForName) {
    const byAlias = devices.find((d) => d.serialNumber === serialForName)
    if (byAlias) return byAlias
  }

  const bySerial = devices.find((d) => d.serialNumber === token)
  if (bySerial) return bySerial

  return devices.find(
    (d) =>
      deviceIdFromSerial(d.serialNumber) === token || getCachedDeviceId(d.serialNumber) === token,
  )
}

function writeDeviceAliases(aliases: Record<string, string>): void {
  mkdirSync(paths.config, {recursive: true})
  writeFileSync(deviceAliasesFilePath(), `${JSON.stringify(aliases, null, 2)}\n`)
}
