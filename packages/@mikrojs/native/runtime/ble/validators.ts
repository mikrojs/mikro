// Pure validation helpers for the BLE module. Extracted so they can be
// unit-tested on the host without pulling in the native `native:ble` module.

import type {AdvertiseInterval, AdvertiseOptions, BleError} from './types.js'

// BLE spec bounds for advertising interval, in milliseconds.
// Non-connectable and connectable modes have different minimums at the spec
// level. We use the looser non-connectable bound in JS and let NimBLE enforce
// the stricter connectable limit at advertise_start time.
export const MIN_INTERVAL_MS = 20
export const MAX_INTERVAL_MS = 10240

// BLE advertising packet is 31 bytes.
export const ADV_PAYLOAD_MAX = 31

// Must mirror the BleError factory in ble.ts. Decoupled here so validators
// don't import from a file that touches the native module.
type BleErrorFactory = {
  InvalidInterval: (min: number, max: number) => BleError
  AdvertisingPayloadTooLarge: (bytes: number, max: number) => BleError
}

export function validateInterval(
  interval: AdvertiseInterval | undefined,
  factory: BleErrorFactory,
): BleError | undefined {
  if (interval === undefined) return undefined
  const {min, max} = interval
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min < MIN_INTERVAL_MS ||
    max > MAX_INTERVAL_MS ||
    min > max
  ) {
    return factory.InvalidInterval(min, max)
  }
  return undefined
}

/**
 * Estimates the total bytes the advertising packet will occupy with the
 * given options. Accounts for the mandatory flags field, the device name,
 * the optional TX power field, and optional manufacturer data.
 *
 * Each AD structure costs 2 bytes of overhead (length byte + type byte)
 * plus the payload size.
 */
export function computeAdvertisingPayloadSize(
  options: AdvertiseOptions,
  fallbackNameLength: number,
): number {
  let total = 3 // flags: 1 length + 1 type + 1 byte value
  const nameLen = options.name !== undefined ? options.name.length : fallbackNameLength
  if (nameLen > 0) total += 2 + nameLen
  if (options.includeTxPower) total += 3
  if (options.manufacturerData !== undefined) {
    total += 2 + options.manufacturerData.length
  }
  return total
}
