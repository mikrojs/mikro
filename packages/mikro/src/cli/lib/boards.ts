import {existsSync, readFileSync, statSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {chips} from '@mikrojs/firmware'
import {type BoardImage, type BoardProblem, loadBoards} from '@mikrojs/firmware/boards'
import {findPackageDir} from '@mikrojs/firmware/manifest'

import {bundledBoardsDir, bundledImages} from './bundledImages.js'
import {assertNoLegacyMikroConfig} from './legacyConfig.js'

export interface BoardInfo {
  /** The board's name, as its firmware reports it ("@acme/boards/t-display",
   *  "esp32c6-generic"). */
  name: string
  /** Target chip (e.g. "esp32s3") */
  chip: string
  description?: string
  /** The export that declares the board ("@acme/boards/t-display"). */
  specifier?: string
  /** The image folder: flasher_args.json and the files it lists. Absent for a
   *  bundled board whose image is missing (in the repository, where the
   *  release has not built them). */
  dir?: string
  /** One of the generic images that ship with mikro. */
  bundled?: boolean
  /** Where `mikro fw prepack` builds the board, when that folder exists (a
   *  workspace, or the board author's own checkout). */
  buildDir?: string
}

/** The suffix of a board's folders in `.mikro/`: none for the board at `.`,
 *  `-t-display` for `./t-display`. */
function boardSuffix(key: string): string {
  return key === '.' ? '' : `-${key.replace(/^\.\//, '')}`
}

/** Where `mikro fw prepack` builds a board: `.mikro/build-fw` for the board at
 *  `.`, `.mikro/build-fw-t-display` for `./t-display`. */
export function boardBuildDir(packageDir: string, key: string): string {
  return path.join(packageDir, '.mikro', `build-fw${boardSuffix(key)}`)
}

/** The firmware project `mikro fw prepack` generates for a board: `.mikro/fw`,
 *  `.mikro/fw-t-display`. */
export function boardProjectDir(packageDir: string, key: string): string {
  return path.join(packageDir, '.mikro', `fw${boardSuffix(key)}`)
}

function fromImage(image: BoardImage, bundled?: boolean): BoardInfo {
  const buildDir = bundled ? undefined : boardBuildDir(image.packageDir, image.key)
  return {
    name: image.name,
    chip: image.chip,
    description: image.description,
    specifier: image.specifier,
    dir: image.dir,
    ...(bundled ? {bundled} : {}),
    ...(buildDir !== undefined && existsSync(buildDir) ? {buildDir} : {}),
  }
}

/** The generic `<chip>-generic` boards, one per supported chip, with the image
 *  mikro ships for it when it has one. */
export function bundledBoards(): BoardInfo[] {
  const {boards} = bundledImages()
  return chips.map((chip) => {
    const image = boards.find((b) => b.name === `${chip}-generic` && b.chip === chip)
    return image
      ? fromImage(image, true)
      : {name: `${chip}-generic`, chip, description: `Generic ${chip} board`, bundled: true}
  })
}

interface PkgJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  /** Legacy config namespace, renamed to `mikro`. Presence is an error. */
  mikrojs?: unknown
}

/**
 * The boards the project's dependencies declare: every export with a
 * `firmware` condition whose firmware.json parses, and the ones that don't (not
 * built, or not a Mikro.js image). The package with the bundled generic
 * boards (the app's mikro) is skipped: they are the fallback, not project
 * boards. So is @mikrojs/firmware, whose versions from before the generic
 * boards moved to mikro export them too.
 */
export async function discoverBoards(
  projectDir: string,
): Promise<{boards: BoardInfo[]; problems: BoardProblem[]}> {
  const boards: BoardInfo[] = []
  const problems: BoardProblem[] = []
  let pkg: PkgJson
  try {
    pkg = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')) as PkgJson
  } catch {
    return {boards, problems}
  }
  assertNoLegacyMikroConfig(pkg, 'package.json')

  const bundled = path.resolve(bundledBoardsDir(projectDir))
  for (const depName of Object.keys({...pkg.dependencies, ...pkg.devDependencies})) {
    if (depName === '@mikrojs/firmware') continue
    const depDir = findPackageDir(depName, projectDir)
    if (depDir === undefined || path.resolve(depDir) === bundled) continue
    const loaded = loadBoards(depDir)
    boards.push(...loaded.boards.map((image) => fromImage(image)))
    problems.push(...loaded.problems)
  }
  return {boards, problems}
}

/** The app binary an image flashes, from its flasher_args.json: named after
 *  the firmware project's `project()`, so not always `mikrojs.bin`. */
function appFile(imageDir: string): string | undefined {
  try {
    const {app} = JSON.parse(readFileSync(path.join(imageDir, 'flasher_args.json'), 'utf8')) as {
      app?: {file?: unknown}
    }
    return typeof app?.file === 'string' ? app.file : undefined
  } catch {
    return undefined
  }
}

/** Why a board's image is older than its last build, or undefined. Only a
 *  board whose build folder is on disk can have one. */
export function staleImage(board: BoardInfo): string | undefined {
  const {dir, buildDir} = board
  if (dir === undefined || buildDir === undefined) return undefined
  const app = appFile(dir)
  if (app === undefined) return undefined
  const built = path.join(buildDir, app)
  const image = path.join(dir, app)
  if (!existsSync(built) || !existsSync(image)) return undefined
  if (statSync(built).mtimeMs <= statSync(image).mtimeMs) return undefined
  return `the image of ${board.name} is older than its last build in ${buildDir}; run \`mikro fw prepack\` in its package`
}
