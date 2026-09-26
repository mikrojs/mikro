import {existsSync, readFileSync, statSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {chips} from '@mikrojs/firmware'
import {
  type BoardImage,
  type BoardProblem,
  genericBoards,
  loadBoards,
} from '@mikrojs/firmware/boards'
import {findPackageDir} from '@mikrojs/firmware/manifest'

import {firmwareBuildDir} from '../commands/idf.js'
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
   *  bundled board whose image this CLI's @mikrojs/firmware lacks (in the
   *  repository, where the release has not built them). */
  dir?: string
  /** One of the generic images @mikrojs/firmware ships with this CLI. */
  bundled?: boolean
  /** The firmware project that builds the image, when it is on disk (a
   *  workspace, or the board author's own checkout). */
  project?: string
}

function fromImage(image: BoardImage, bundled?: boolean): BoardInfo {
  const project = bundled ? undefined : firmwareProjectOf(image.packageDir, image.key)
  return {
    name: image.name,
    chip: image.chip,
    description: image.description,
    specifier: image.specifier,
    dir: image.dir,
    ...(bundled ? {bundled} : {}),
    ...(project ? {project} : {}),
  }
}

/** The generic `<chip>-generic` boards, one per supported chip, with the image
 *  @mikrojs/firmware ships for it when it has one. */
export function bundledBoards(): BoardInfo[] {
  const {boards} = genericBoards()
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
 * built, or not a Mikro.js image). @mikrojs/firmware's own generic images are
 * the bundled boards, not project boards.
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

  for (const depName of Object.keys({...pkg.dependencies, ...pkg.devDependencies})) {
    if (depName === '@mikrojs/firmware') continue
    const depDir = findPackageDir(depName, projectDir)
    if (depDir === undefined) continue
    const loaded = loadBoards(depDir)
    boards.push(...loaded.boards.map((image) => fromImage(image)))
    problems.push(...loaded.problems)
  }
  return {boards, problems}
}

/** Where the docs and suggestions put a package's images: `dist-fw/` for the
 *  firmware project at the package root, `dist-fw/<folder>/` for one in a
 *  folder. The package decides; its exports say where they are. */
export const IMAGE_ROOT = 'dist-fw'

/** The firmware project that builds the image of a package export: the package
 *  root for `.`, `<folder>` for `./<folder>`. Undefined when that folder has no
 *  CMakeLists.txt, as in an installed package. */
export function firmwareProjectOf(packageDir: string, key: string): string | undefined {
  const project = path.join(packageDir, key)
  return existsSync(path.join(project, 'CMakeLists.txt')) ? project : undefined
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

/** Why a board's image is older than its firmware project's last `mikro idf`
 *  build, or undefined. Only a board whose firmware project is on disk can
 *  have one. */
export function staleImage(board: BoardInfo): string | undefined {
  const {dir, project} = board
  if (dir === undefined || project === undefined) return undefined
  const app = appFile(dir)
  if (app === undefined) return undefined
  const built = path.join(firmwareBuildDir(project), app)
  const image = path.join(dir, app)
  if (!existsSync(built) || !existsSync(image)) return undefined
  if (statSync(built).mtimeMs <= statSync(image).mtimeMs) return undefined
  return `the image of ${board.name} is older than the last build in ${project}; run \`mikro fw prepack\` there`
}
