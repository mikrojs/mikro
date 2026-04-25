import {createRequire} from 'node:module'

import {satisfies} from 'semver'

export interface FirmwareCompatResult {
  compatible: boolean
  deviceVersion: string | null
  requiredRange: string | null
}

/**
 * Check whether the device firmware version satisfies the CLI's
 * declared compatibility range (engines["@mikrojs/firmware"]).
 *
 * Incompatible when:
 *   - The device didn't report a version (old firmware)
 *   - The device version doesn't satisfy the range
 *
 * Compatible when:
 *   - The version satisfies the range, OR
 *   - No range is declared in engines
 */
export function checkFirmwareCompat(deviceVersion: string | null): FirmwareCompatResult {
  const require = createRequire(import.meta.url)
  const pkg = require('../../../package.json') as {engines?: Record<string, string>}
  const range = pkg.engines?.['@mikrojs/firmware'] ?? null

  if (!range) {
    return {compatible: true, deviceVersion, requiredRange: range}
  }

  if (!deviceVersion) {
    return {compatible: false, deviceVersion, requiredRange: range}
  }

  return {
    compatible: satisfies(deviceVersion, range),
    deviceVersion,
    requiredRange: range,
  }
}
