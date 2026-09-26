import {existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Chips the firmware supports, from chips.json (e.g. "esp32c6"). */
export const chips = JSON.parse(readFileSync(join(__dirname, 'chips.json'), 'utf8')).chips

const prebuildsRoot = join(__dirname, 'prebuilds')

// Generic prebuilds live in board-named `<chip>-generic/` dirs; `<chip>/` is
// the legacy layout of older published packages and local states.
export function prebuiltFirmwareDir(chip) {
  const boardDir = join(prebuildsRoot, `${chip}-generic`)
  if (existsSync(join(boardDir, 'flasher_args.json'))) return boardDir
  return join(prebuildsRoot, chip)
}

export function hasPrebuiltFirmware(chip) {
  return existsSync(join(prebuiltFirmwareDir(chip), 'flasher_args.json'))
}

/** Identity of the bundled prebuilt for `chip` (the package name of the
 *  firmware project it was built from), or undefined when no prebuilt or no
 *  recorded identity exists. */
export function prebuiltFirmwareName(chip) {
  try {
    const {name} = JSON.parse(
      readFileSync(join(prebuiltFirmwareDir(chip), 'firmware.json'), 'utf8'),
    )
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}
