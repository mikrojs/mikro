import {existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const componentDir = join(__dirname, 'components')
export const configDir = __dirname
export const defaultAppDir = join(__dirname, 'default-app')
export const projectCmakePath = join(__dirname, 'project.cmake')

const prebuildsRoot = join(__dirname, 'prebuilds')

export function prebuiltFirmwareDir(chip) {
  return join(prebuildsRoot, chip)
}

export function hasPrebuiltFirmware(chip) {
  return existsSync(join(prebuildsRoot, chip, 'flasher_args.json'))
}

/** Identity of the bundled prebuilt for `chip` (the package name of the
 *  firmware project it was built from), or undefined when no prebuilt or no
 *  recorded identity exists. */
export function prebuiltFirmwareName(chip) {
  try {
    const {name} = JSON.parse(readFileSync(join(prebuildsRoot, chip, 'firmware.json'), 'utf8'))
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}
