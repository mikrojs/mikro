import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

/** The package root: src/ or dist/ is one level down. */
const packageRoot = join(import.meta.dirname, '..')

/** Chips the firmware supports, from chips.json (e.g. "esp32c6"). */
export const chips: string[] = (
  JSON.parse(readFileSync(join(packageRoot, 'chips.json'), 'utf8')) as {chips: string[]}
).chips

const prebuildsRoot = join(packageRoot, 'prebuilds')

// Generic prebuilds live in board-named `<chip>-generic/` dirs; `<chip>/` is
// the legacy layout of older published packages and local states.
export function prebuiltFirmwareDir(chip: string): string {
  const boardDir = join(prebuildsRoot, `${chip}-generic`)
  if (existsSync(join(boardDir, 'flasher_args.json'))) return boardDir
  return join(prebuildsRoot, chip)
}

export function hasPrebuiltFirmware(chip: string): boolean {
  return existsSync(join(prebuiltFirmwareDir(chip), 'flasher_args.json'))
}

/** Identity of the bundled prebuilt for `chip` (the package name of the
 *  firmware project it was built from), or undefined when no prebuilt or no
 *  recorded identity exists. */
export function prebuiltFirmwareName(chip: string): string | undefined {
  try {
    const {name} = JSON.parse(
      readFileSync(join(prebuiltFirmwareDir(chip), 'firmware.json'), 'utf8'),
    ) as {name?: unknown}
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}
