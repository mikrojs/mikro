import {createRequire} from 'node:module'

import {lt, major, minor, patch, satisfies} from 'semver'

import {installLatestCommand, mikroCommand, type PkgManager} from './pkgManager.js'

export type FirmwareCompatStatus = 'match' | 'update_available' | 'incompatible'
export type FirmwareCompatDirection = 'device_older' | 'device_newer'

export interface FirmwareCompatResult {
  status: FirmwareCompatStatus
  /** Only set when status === 'update_available'. */
  direction: FirmwareCompatDirection | null
  deviceVersion: string | null
  cliVersion: string
  requiredRange: string
}

const require = createRequire(import.meta.url)
const cliVersion = (require('../../../package.json') as {version: string}).version

/**
 * Floor of the breakage range, per semver `^` conventions:
 *   1.2.3 → 1.0.0    (same major)
 *   0.7.3 → 0.7.0    (same minor in 0.x)
 *   0.0.7 → 0.0.7    (exact in 0.0.x)
 */
function breakageFloor(version: string): string {
  const m = major(version)
  if (m > 0) return `${m}.0.0`
  const min = minor(version)
  if (min > 0) return `0.${min}.0`
  return `0.0.${patch(version)}`
}

const requiredRange = `^${breakageFloor(cliVersion)}`

/**
 * Check whether the firmware version reported by the device is semver-
 * compatible with this CLI's version. mikrojs and @mikrojs/firmware are
 * versioned in lockstep, so the CLI's own version is the source of truth.
 *
 * Returns one of:
 *   - 'match'              — device version equals CLI version
 *   - 'update_available'   — device satisfies the breakage range but is older or newer
 *   - 'incompatible'       — device is outside the range, or didn't report a version
 */
export function checkFirmwareCompat(deviceVersion: string | null): FirmwareCompatResult {
  if (!deviceVersion || !satisfies(deviceVersion, requiredRange, {includePrerelease: true})) {
    return {status: 'incompatible', direction: null, deviceVersion, cliVersion, requiredRange}
  }
  if (deviceVersion === cliVersion) {
    return {status: 'match', direction: null, deviceVersion, cliVersion, requiredRange}
  }
  const direction: FirmwareCompatDirection = lt(deviceVersion, cliVersion)
    ? 'device_older'
    : 'device_newer'
  return {status: 'update_available', direction, deviceVersion, cliVersion, requiredRange}
}

/** Format the soft "update available" notice (status === 'update_available'). */
export function formatAdvisory(result: FirmwareCompatResult, pm: PkgManager): string {
  const {direction, deviceVersion, cliVersion: cli} = result
  if (direction === 'device_older') {
    return [
      `Update available: device is running mikrojs v${deviceVersion}; your project uses v${cli}.`,
      `Run ${mikroCommand(pm, 'flash')} to update.`,
    ].join('\n')
  }
  // device_newer
  return [
    `Update available: your project uses mikrojs v${cli}; device is running v${deviceVersion}.`,
    `Run ${installLatestCommand(pm, 'mikrojs')} to sync.`,
  ].join('\n')
}

/**
 * Thrown when the device firmware version is incompatible with this CLI.
 * Lets callers tell this apart from a generic transport/timeout failure
 * (the message is self-explanatory and shouldn't be paired with generic
 * troubleshooting hints).
 */
export class FirmwareIncompatibleError extends Error {
  override name = 'FirmwareIncompatibleError'
}

/** Format the hard incompatibility error (status === 'incompatible'). */
export function formatIncompatibleError(result: FirmwareCompatResult, pm: PkgManager): string {
  const got = result.deviceVersion ?? 'unknown'
  return `Device is running mikrojs v${got}, which is not compatible with this CLI (v${result.cliVersion}). Run ${mikroCommand(pm, 'flash')} to update device.`
}
