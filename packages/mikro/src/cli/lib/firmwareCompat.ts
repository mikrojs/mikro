import pkg from 'mikro/package.json' with {type: 'json'}
import {lt, major, minor, patch, satisfies} from 'semver'

import {
  installLatestCommand,
  installVersionCommand,
  mikroCommand,
  type PkgManager,
} from './pkgManager.js'

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

const defaultCliVersion = pkg.version

/**
 * npm strips `+sha` build metadata from versions at publish, but firmware
 * builds bake the unstripped package.json version into `sys.version`. The
 * same release can therefore reach us under both spellings; build metadata
 * never indicates a different release, so comparisons must ignore it.
 */
function stripBuildMetadata(version: string): string {
  const plus = version.indexOf('+')
  return plus === -1 ? version : version.slice(0, plus)
}

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

/**
 * Check whether the firmware version reported by the device is semver-
 * compatible with this CLI's version. mikrojs and @mikrojs/firmware are
 * versioned in lockstep, so the CLI's own version is the source of truth.
 * `cliVersion` is injectable for tests; production callers omit it.
 *
 * Returns one of:
 *   - 'match'              — device version equals CLI version
 *   - 'update_available'   — device satisfies the breakage range but is older or newer
 *   - 'incompatible'       — device is outside the range, or didn't report a version
 */
export function checkFirmwareCompat(
  deviceVersion: string | null,
  cliVersion: string = defaultCliVersion,
): FirmwareCompatResult {
  const requiredRange = `^${breakageFloor(cliVersion)}`
  // Exact equality first (modulo build metadata): a prerelease build sorts
  // below its own breakage floor in semver, so the range check would wrongly
  // flag a device running the very same build as incompatible.
  if (deviceVersion && stripBuildMetadata(deviceVersion) === stripBuildMetadata(cliVersion)) {
    return {status: 'match', direction: null, deviceVersion, cliVersion, requiredRange}
  }
  if (!deviceVersion || !satisfies(deviceVersion, requiredRange, {includePrerelease: true})) {
    return {status: 'incompatible', direction: null, deviceVersion, cliVersion, requiredRange}
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
    `Run ${installLatestCommand(pm, 'mikro')} to sync.`,
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

/**
 * Format the warning shown when a read-only diagnostic command proceeds
 * against incompatible firmware (best-effort mode). Unlike the hard error,
 * this points the user at matching the CLI to the device — the device may be
 * a deployed unit you can't reflash, and the goal is to read its state. When
 * the device reported a concrete version we suggest installing that exact CLI;
 * otherwise (no version reported) the firmware predates version reporting, so
 * only reflashing can help.
 */
export function formatBestEffortWarning(result: FirmwareCompatResult, pm: PkgManager): string {
  const {deviceVersion, cliVersion: cli} = result
  if (!deviceVersion) {
    return [
      `Device firmware did not report a version and may be too old for this CLI (v${cli}).`,
      `Attempting anyway. If it fails, run ${mikroCommand(pm, 'flash')} to update the device.`,
    ].join('\n')
  }
  return [
    `Device is running mikrojs v${deviceVersion}, which is not compatible with this CLI (v${cli}).`,
    `Attempting anyway. If it fails, install a matching CLI (${installVersionCommand(pm, 'mikro', deviceVersion)}) or run ${mikroCommand(pm, 'flash')} to update the device.`,
  ].join('\n')
}
