import {existsSync} from 'node:fs'
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
