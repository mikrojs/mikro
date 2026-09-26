import {existsSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  type BoardProblem,
  checkBoardPackage,
  type FirmwareExport,
  firmwareExports,
  loadBoards,
} from '@mikrojs/firmware/boards'
import {findPackageRoot} from '@mikrojs/firmware/manifest'

import {firmwareProjectOf, IMAGE_ROOT, staleImage} from './boards.js'
import {UserError} from './errorMessage.js'
import {readFlasherArgs} from './esptool.js'
import {checkFirmwareCompat} from './firmwareCompat.js'

/** The files of the image in `dir`, relative to it: flasher_args.json, the
 *  files it flashes, and firmware.json (which builds before it lack). */
export async function imageFiles(dir: string): Promise<string[]> {
  const flasherArgs = await readFlasherArgs(dir)
  return [
    'flasher_args.json',
    ...(existsSync(path.join(dir, 'firmware.json')) ? ['firmware.json'] : []),
    ...flasherArgs.files.map((file) => path.relative(dir, file.filename)),
  ]
}

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * Replace the image in `imageDir` with the one in the build directory. The
 * folder is replaced whole, so it must hold nothing but an image: not the
 * build directory or a folder around it, not the firmware project or a folder
 * around it, not the images of other firmware projects, and if it exists,
 * empty or already an image.
 */
export async function writeImage(
  buildDir: string,
  imageDir: string,
  projectDir: string,
): Promise<void> {
  const image = path.resolve(imageDir)
  const build = path.resolve(buildDir)
  const ownFolder = `Point the "firmware" export at a folder of its own, such as ${IMAGE_ROOT}/.`
  if (within(build, image) || within(image, build) || within(path.resolve(projectDir), image)) {
    throw new UserError(
      `The "firmware" export points into ${image}, which holds more than the image, ` +
        `and mikro fw prepack replaces the whole folder. ${ownFolder}`,
    )
  }
  if (existsSync(image)) {
    const entries = await fs.readdir(image)
    const others = entries.filter((e) => existsSync(path.join(image, e, 'firmware.json')))
    if (others.length > 0) {
      throw new UserError(
        `${image} holds the images of other firmware projects (${others.join(', ')}), and ` +
          `mikro fw prepack replaces the whole folder. A package has one firmware project at ` +
          `its root, or one in each board's folder, not both.`,
      )
    }
    if (
      entries.length > 0 &&
      !entries.includes('firmware.json') &&
      !entries.includes('flasher_args.json')
    ) {
      throw new UserError(
        `${image} holds files that are not an image, and mikro fw prepack replaces the whole ` +
          `folder. ${ownFolder}`,
      )
    }
  }
  const files = await imageFiles(buildDir)
  await fs.rm(image, {recursive: true, force: true})
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(image, file)), {recursive: true})
    await fs.copyFile(path.join(buildDir, file), path.join(image, file))
  }
}

/**
 * The export of the package around `projectDir` whose image this firmware
 * project builds: `.` for a project at the package root, `./<folder>` for one
 * in `<folder>/`. Undefined when the package has no such `firmware` export.
 */
export function ownBoardExport(
  projectDir: string,
): {packageDir: string; entry: FirmwareExport} | undefined {
  const packageDir = findPackageRoot(projectDir)
  if (packageDir === undefined) return undefined
  const project = path.resolve(projectDir)
  const entry = firmwareExports(packageDir).entries.find(
    (e) => firmwareProjectOf(packageDir, e.key) === project,
  )
  return entry && {packageDir, entry}
}

/** The export a firmware project without one could add, for error messages. */
export function suggestedExport(packageDir: string, projectDir: string): string {
  const inPackage = path.relative(packageDir, path.resolve(projectDir)).split(path.sep).join('/')
  const key = inPackage === '' ? '.' : `./${inPackage}`
  const target = `./${[IMAGE_ROOT, inPackage].filter(Boolean).join('/')}/firmware.json`
  return `"${key}": {"firmware": "${target}"}`
}

/**
 * Everything wrong with a board package's images: checkBoardPackage's list,
 * plus what depends on this CLI (images from a version it doesn't accept, and
 * images older than their firmware project's last build).
 */
export function boardPackageProblems(packageDir: string): BoardProblem[] {
  const problems = checkBoardPackage(packageDir)
  for (const board of loadBoards(packageDir).boards) {
    const compat = checkFirmwareCompat(board.version)
    if (compat.status === 'incompatible') {
      problems.push({
        specifier: board.specifier,
        message: `${board.name} was built with ${board.version}, which this CLI (${compat.cliVersion}) does not accept (${compat.requiredRange})`,
      })
    }
    const project = firmwareProjectOf(packageDir, board.key)
    const stale = staleImage({name: board.name, chip: board.chip, dir: board.dir, project})
    if (stale) problems.push({specifier: board.specifier, message: stale})
  }
  return problems
}
