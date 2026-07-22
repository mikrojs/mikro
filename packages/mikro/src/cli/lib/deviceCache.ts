import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {SerialPort} from 'serialport'

import {paths} from './envPaths.js'

/**
 * Machine-managed cache of USB serial → last-seen {chip, deviceId, name}, so
 * the picker and `ls` can show them while a board is disconnected. The device id
 * is cached mainly for USB-UART bridge boards, whose serial isn't the chip MAC
 * and so can't be derived offline. Rewritten on every connect, not hand-edited.
 * Firmware version is not cached — it goes stale on reflash.
 *
 * `name` mirrors the device's own name (mik.sys `name`), reported in the connect
 * handshake. Absent means no name is set on the device and callers derive one
 * from the device id, so the handshake clears a stale entry as well as sets it.
 */

export interface CachedDevice {
  chip?: string
  deviceId?: string
  name?: string
}

/** What a caller reports after a handshake. `name` is required, and `null`
 *  means "this device has no name": the write is authoritative either way, so
 *  leaving it optional would let a caller reporting only a chip silently wipe a
 *  good name. */
export interface DeviceFacts {
  chip?: string
  deviceId?: string
  name: string | null
}

export function deviceCacheFilePath(): string {
  return join(paths.cache, 'device-cache.json')
}

function read(): Record<string, CachedDevice> {
  let raw: string
  try {
    raw = readFileSync(deviceCacheFilePath(), 'utf-8')
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
  const out: Record<string, CachedDevice> = {}
  for (const [serial, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value && typeof value === 'object') {
      const {chip, deviceId, name} = value as Record<string, unknown>
      const entry: CachedDevice = {}
      if (typeof chip === 'string' && chip) entry.chip = chip
      if (typeof deviceId === 'string' && deviceId) entry.deviceId = deviceId
      if (typeof name === 'string' && name) entry.name = name
      if (entry.chip || entry.deviceId || entry.name) out[serial] = entry
    }
  }
  return out
}

export function getCachedChip(serialNumber: string | undefined): string | undefined {
  if (!serialNumber) return undefined
  return read()[serialNumber]?.chip
}

export function getCachedDeviceId(serialNumber: string | undefined): string | undefined {
  if (!serialNumber) return undefined
  return read()[serialNumber]?.deviceId
}

/** The name the device last reported for itself, if it has one set. */
export function getCachedName(serialNumber: string | undefined): string | undefined {
  if (!serialNumber) return undefined
  return read()[serialNumber]?.name
}

/** Same, for callers holding only a firmware-reported device id (no live USB
 *  serial), e.g. after an enroll handshake. */
export function getCachedNameByDeviceId(deviceId: string | null | undefined): string | undefined {
  if (!deviceId) return undefined
  for (const entry of Object.values(read())) {
    if (entry.deviceId === deviceId && entry.name) return entry.name
  }
  return undefined
}

function remember(serialNumber: string, fields: CachedDevice): void {
  const cache = read()
  const existing = cache[serialNumber] ?? {}
  const next = {...existing, ...fields}
  if (
    existing.chip === next.chip &&
    existing.deviceId === next.deviceId &&
    existing.name === next.name
  ) {
    return
  }
  cache[serialNumber] = next
  mkdirSync(paths.cache, {recursive: true})
  writeFileSync(deviceCacheFilePath(), `${JSON.stringify(cache, null, 2)}\n`)
}

/** Records connect-handshake facts for a port's serial. Never throws: a cache
 *  write must not disrupt a live session. `name` is authoritative, so passing
 *  `null` clears a stale one. */
export async function rememberDeviceForPort(
  port: string | undefined,
  facts: DeviceFacts,
): Promise<void> {
  if (!port || port === 'simulator') return
  const fields: CachedDevice = {name: facts.name ?? undefined}
  if (facts.chip) fields.chip = facts.chip
  if (facts.deviceId) fields.deviceId = facts.deviceId
  try {
    const devices = await SerialPort.list()
    const serial = devices.find((d) => d.path === port)?.serialNumber
    if (serial) remember(serial, fields)
  } catch {
    // ignore port-enumeration failures
  }
}
