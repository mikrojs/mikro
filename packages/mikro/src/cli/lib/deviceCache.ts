import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {SerialPort} from 'serialport'

import {paths} from './envPaths.js'

/**
 * Machine-managed cache of USB serial → last-seen {chip, deviceId}, so the
 * picker and `ls` can show them while a board is disconnected. The device id is
 * cached mainly for USB-UART bridge boards, whose serial isn't the chip MAC and
 * so can't be derived offline. Rewritten on every connect, not hand-edited.
 * Firmware version is not cached — it goes stale on reflash.
 */

export interface CachedDevice {
  chip?: string
  deviceId?: string
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
      const {chip, deviceId} = value as Record<string, unknown>
      const entry: CachedDevice = {}
      if (typeof chip === 'string' && chip) entry.chip = chip
      if (typeof deviceId === 'string' && deviceId) entry.deviceId = deviceId
      if (entry.chip || entry.deviceId) out[serial] = entry
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

function remember(serialNumber: string, fields: CachedDevice): void {
  const cache = read()
  const existing = cache[serialNumber] ?? {}
  const next = {...existing, ...fields}
  if (existing.chip === next.chip && existing.deviceId === next.deviceId) return
  cache[serialNumber] = next
  mkdirSync(paths.cache, {recursive: true})
  writeFileSync(deviceCacheFilePath(), `${JSON.stringify(cache, null, 2)}\n`)
}

/** Records connect-handshake facts for a port's serial. Never throws — a cache
 *  write must not disrupt a live session. */
export async function rememberDeviceForPort(
  port: string | undefined,
  facts: CachedDevice,
): Promise<void> {
  if (!port || port === 'simulator') return
  const fields: CachedDevice = {}
  if (facts.chip) fields.chip = facts.chip
  if (facts.deviceId) fields.deviceId = facts.deviceId
  if (!fields.chip && !fields.deviceId) return
  try {
    const devices = await SerialPort.list()
    const serial = devices.find((d) => d.path === port)?.serialNumber
    if (serial) remember(serial, fields)
  } catch {
    // ignore port-enumeration failures
  }
}
