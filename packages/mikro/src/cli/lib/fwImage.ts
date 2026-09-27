import {existsSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  type BoardProblem,
  checkBoardPackage,
  type ConfiguredBoard,
  type ConfiguredImage,
  FULL_IMAGE,
  loadBoards,
  readFirmwareJson,
} from '@mikrojs/firmware/boards'

import {boardBuildDir, staleImage} from './boards.js'
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

/** What Finder leaves in a folder it shows, which says nothing about it. */
const FINDER_FILES = new Set(['.DS_Store'])

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** Copy the image in `buildDir` (imageFiles) into `dir`. */
async function copyImage(buildDir: string, dir: string): Promise<void> {
  for (const file of await imageFiles(buildDir)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), {recursive: true})
    await fs.copyFile(path.join(buildDir, file), path.join(dir, file))
  }
}

/**
 * Replace a board's folder with its full image, built in `fullBuild`, in
 * `full/`, and each of its other images in a folder beside it. The folder is
 * replaced whole, so it must hold nothing but this board's images: not a
 * build directory or a folder around one, not the firmware project or a folder
 * around it, no other board's image, and if it exists, empty or images.
 */
export async function writeBoardImages(
  board: {name: string; boardDir: string},
  fullBuild: string,
  imageBuilds: {name: string; buildDir: string}[],
  projectDir: string,
): Promise<void> {
  const dir = path.resolve(board.boardDir)
  const builds = [fullBuild, ...imageBuilds.map((i) => i.buildDir)].map((b) => path.resolve(b))
  const ownFolder = 'Set "dist" in boards.config.ts to a folder of its own, such as dist-fw.'
  if (
    builds.some((build) => within(build, dir) || within(dir, build)) ||
    within(path.resolve(projectDir), dir)
  ) {
    throw new UserError(
      `The image folder ${dir} holds more than the images, and mikro fw build replaces ` +
        `the whole folder. ${ownFolder}`,
    )
  }
  if (existsSync(dir)) {
    const entries = (await fs.readdir(dir)).filter((e) => !FINDER_FILES.has(e))
    // This board's images, current or no longer configured, are replaced too
    const nested = entries.filter((e) => existsSync(path.join(dir, e, 'firmware.json')))
    const others = nested.filter((e) => {
      const read = readFirmwareJson(path.join(dir, e, 'firmware.json'))
      return !read.ok || read.value.name !== board.name
    })
    if (others.length > 0) {
      throw new UserError(
        `${dir} holds the images of other boards (${others.join(', ')}), and mikro fw ` +
          'build replaces the whole folder. Delete them if the package no longer has those boards.',
      )
    }
    // An image written straight into the folder, before images moved to full/
    const rest = entries.filter((e) => !nested.includes(e))
    if (rest.length > 0 && !rest.includes('firmware.json') && !rest.includes('flasher_args.json')) {
      throw new UserError(
        `${dir} holds files that are not an image, and mikro fw build replaces the whole ` +
          `folder. ${ownFolder}`,
      )
    }
  }
  await fs.rm(dir, {recursive: true, force: true})
  await copyImage(fullBuild, path.join(dir, FULL_IMAGE))
  for (const {name, buildDir} of imageBuilds) {
    await copyImage(buildDir, path.join(dir, name))
  }
}

/**
 * Replace one image of a board (`full`, or `no-ble`), built in `buildDir`,
 * leaving its others: `mikro fw build --image`. The image's folder must not
 * hold a build or the firmware project, and if it has anything in it, it must
 * be an image of this board.
 */
export async function writeBoardImage(
  board: {name: string; boardDir: string},
  image: string,
  buildDir: string,
  projectDir: string,
): Promise<string> {
  const dir = path.join(path.resolve(board.boardDir), image)
  const build = path.resolve(buildDir)
  if (within(build, dir) || within(dir, build) || within(path.resolve(projectDir), dir)) {
    throw new UserError(
      `The image folder ${dir} holds more than the image, and mikro fw build replaces the ` +
        'whole folder. Set "dist" in boards.config.ts to a folder of its own, such as dist-fw.',
    )
  }
  if (existsSync(dir) && (await fs.readdir(dir)).some((e) => !FINDER_FILES.has(e))) {
    const read = readFirmwareJson(path.join(dir, 'firmware.json'))
    if (!read.ok || read.value.name !== board.name) {
      throw new UserError(
        `${dir} holds something other than an image of ${board.name}, and mikro fw build ` +
          'replaces the whole folder.',
      )
    }
  }
  await fs.rm(dir, {recursive: true, force: true})
  await copyImage(buildDir, dir)
  return dir
}

/** Whether two feature lists hold the same features. */
function sameFeatures(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((feature) => b.includes(feature))
}

/** Images that don't match their board in boards.config.ts: another name or
 *  chip, other images than the config lists, or an image without the features
 *  it asks for, or with just the full image's (built before the config
 *  changed, or asking for what the full image already is). An image not built
 *  is checkBoardPackage's to report. */
export function configuredImageProblems(
  packageDir: string,
  boards: ConfiguredBoard[],
): BoardProblem[] {
  const built = loadBoards(packageDir).boards
  const problems: BoardProblem[] = []
  for (const board of boards) {
    const full = built.find((i) => i.key === board.key)
    if (full === undefined) continue
    const problem = (message: string) => problems.push({specifier: board.specifier, message})
    if (full.name !== board.name || full.chip !== board.chip) {
      problem(
        `the image is ${full.name} for ${full.chip}, but boards.config.ts has ` +
          `${board.name} for ${board.chip}; run \`mikro fw build\``,
      )
    }
    const names = (list: string[]) => (list.length > 0 ? list.join(', ') : 'none')
    const listed = (full.images ?? []).map((i) => i.name).sort()
    const wanted = board.images.map((i) => i.name).sort()
    if (listed.join() !== wanted.join()) {
      problem(
        `the other images built are ${names(listed)}, but boards.config.ts has ` +
          `${names(wanted)}; run \`mikro fw build\``,
      )
    }
    for (const configured of board.images) {
      const image = full.images?.find((i) => i.name === configured.name)
      if (image === undefined) continue
      for (const message of featureProblems(configured, image.features)) problem(message)
      if (full.features !== undefined && sameFeatures(image.features, full.features)) {
        problem(
          `the ${configured.name} image has the same features as the full image ` +
            `(${names(full.features)}); leave it out of "images"`,
        )
      }
    }
  }
  return problems
}

/** Features an image has that its config switches off, or lacks that it
 *  switches on. */
function featureProblems(configured: ConfiguredImage, features: string[]): string[] {
  return Object.entries(configured.features)
    .filter(([feature, on]) => features.includes(feature) !== on)
    .map(([feature, on]) => `the ${configured.name} image ${on ? 'lacks' : 'has'} ${feature}`)
}

/** What is wrong with one image `mikro fw build --image` wrote: not an image
 *  of the board, or without the features its config asks for. The board's
 *  other images may not be built, so the package as a whole is `fw check`'s. */
export function builtImageProblems(board: ConfiguredBoard, image: string): BoardProblem[] {
  const read = readFirmwareJson(path.join(board.boardDir, image, 'firmware.json'))
  const problems = (messages: string[]) =>
    messages.map((message) => ({specifier: board.specifier, message}))
  if (!read.ok) return problems([read.message])
  if (read.value.name !== board.name || read.value.chip !== board.chip) {
    return problems([
      `the ${image} image is ${read.value.name} for ${read.value.chip}, but boards.config.ts ` +
        `has ${board.name} for ${board.chip}`,
    ])
  }
  const configured = board.images.find((i) => i.name === image)
  return problems(configured ? featureProblems(configured, read.value.features ?? []) : [])
}

/**
 * Everything wrong with a board package's images: checkBoardPackage's list,
 * plus what depends on this CLI (images from a version it doesn't accept, and
 * images older than their last build).
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
    const buildDir = boardBuildDir(packageDir, board.key)
    const stale = staleImage({name: board.name, chip: board.chip, dir: board.dir, buildDir})
    if (stale) problems.push({specifier: board.specifier, message: stale})
  }
  return problems
}
