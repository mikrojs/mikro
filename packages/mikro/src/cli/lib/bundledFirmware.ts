import {prebuiltFirmwareName} from '@mikrojs/firmware'

/**
 * The device's reported firmware identity when it is NOT the firmware
 * bundled with this CLI, else undefined. Drives the auto-reflash guard: the
 * CLI only flashes its bundled prebuilt over a device whose identity matches
 * the name recorded in that prebuilt's bundle, so a reflash always replaces
 * like with like.
 *
 * A device that reports no identity predates identity reporting and is
 * treated as the bundled firmware: outdated devices running it are exactly
 * what the auto-reflash exists for. A reported identity with no matching
 * prebuilt record (unknown chip, missing bundle metadata) counts as custom,
 * refusing the flash.
 *
 * `bundledName` is injectable for tests; production callers omit it.
 */
export function customFirmwareOf(
  ready: {fw?: string | undefined; chip?: string | null | undefined},
  bundledName: string | undefined = ready.chip ? prebuiltFirmwareName(ready.chip) : undefined,
): string | undefined {
  if (ready.fw === undefined) return undefined
  return ready.fw === bundledName ? undefined : ready.fw
}
