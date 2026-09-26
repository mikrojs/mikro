import {bundledBoards} from './boards.js'

/**
 * The device's reported firmware identity when it is NOT the firmware
 * bundled with this CLI, else undefined. Drives the auto-reflash guard: the
 * CLI only flashes its bundled prebuilt over a device whose identity matches
 * the name in that image's firmware.json, so a reflash always replaces like
 * with like.
 *
 * A device that reports no identity predates identity reporting and is
 * treated as the bundled firmware: outdated devices running it are exactly
 * what the auto-reflash exists for. A reported identity with no matching
 * bundled image (unknown chip, or an image this CLI lacks) counts as custom,
 * refusing the flash.
 *
 * `bundledName` is injectable for tests; production callers omit it.
 */
export function customFirmwareOf(
  ready: {fw?: string | undefined; chip?: string | null | undefined},
  bundledName: string | undefined = bundledBoards().find((b) => b.chip === ready.chip && b.dir)
    ?.name,
): string | undefined {
  if (ready.fw === undefined) return undefined
  return ready.fw === bundledName ? undefined : ready.fw
}
