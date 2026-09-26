/**
 * Board packages: prebuilt firmware images that a package declares with a
 * `firmware` condition on its exports, pointing at the image's firmware.json:
 *
 *   "./t-display": {"firmware": "./dist-fw/t-display/firmware.json", "default": "./dist/t-display/index.js"}
 *
 * The image folder holds what `mikro fw prepack` copies out of a build:
 * firmware.json (written by the mikrojs component's CMake), flasher_args.json
 * and the files it lists. A board names itself: the name in firmware.json is
 * the name its firmware reports as sys.board.name. A `firmware` target counts
 * as a board only if its firmware.json parses, so another tool's `firmware`
 * condition is reported, not taken for a board.
 *
 * @mikrojs/firmware's own generic images are boards too (`./esp32c6-generic`).
 */
import {existsSync, readFileSync} from 'node:fs'
import {dirname, join, relative, resolve, sep} from 'node:path'

import {enumOf, object, optional, string, validate} from '@mikrojs/schema'

import {chips} from './index.ts'

/** A board's image, as its firmware.json describes it. */
export interface BoardImage {
  /** The name the firmware reports: `@acme/devboard`, `esp32c6-generic`. */
  name: string
  description?: string
  chip: string
  /** The Mikro.js version the image was built with. */
  version: string
  /** The specifier of the export that declares the board: `@acme/boards/t-display`. */
  specifier: string
  /** That export's key: `.`, `./t-display`. */
  key: string
  packageName: string
  packageDir: string
  /** The image folder: firmware.json, flasher_args.json and the files it lists. */
  dir: string
}

/** Something wrong with one of a package's `firmware` exports. */
export interface BoardProblem {
  /** The export's specifier, or the package name for a package-wide problem. */
  specifier: string
  message: string
}

/** A `firmware` entry of a package's exports. */
export interface FirmwareExport {
  key: string
  specifier: string
  /** The target as written, and resolved against the package. */
  target: string
  file: string
}

/** The form of a board name: a package name, optionally with /<board>. The
 *  device keeps it in a 64-byte buffer, and a registry checks the same form
 *  (docs/registry-spec.md, "Board names"). */
const BOARD_NAME_RE =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?)?$/
const MAX_BOARD_NAME_LENGTH = 63

const FirmwareJson = object({
  name: string(),
  description: optional(string()),
  chip: enumOf(chips.map((chip) => ({value: chip}))),
  version: string(),
})

interface PackageJson {
  name?: string
  exports?: unknown
  publishConfig?: {exports?: unknown}
  files?: unknown
}

/** A board's name in file and artifact names: `@acme/pi` becomes `acme-pi`. */
export function boardFileName(name: string): string {
  return name.replace(/^@/, '').replaceAll('/', '-')
}

/**
 * The name of an image's archive, without `.tar.gz`: `mikro-fw-<name>-<chip>`,
 * or `mikro-fw-<chip>` for firmware without a name. The chip is left out when
 * the name already ends with it (`seeed-xiao-esp32c6`) or is `<chip>-generic`,
 * so the chip is always the last word, or the one before `generic`.
 * `mikro fw pack` names archives this way, and `mikro flash --from` looks for
 * them; the CI artifact of a build has the same name.
 */
export function archiveName(name: string | undefined, chip: string): string {
  if (name === undefined) return `mikro-fw-${chip}`
  const fileName = boardFileName(name)
  return fileName.endsWith(`-${chip}`) || fileName === chip || fileName === `${chip}-generic`
    ? `mikro-fw-${fileName}`
    : `mikro-fw-${fileName}-${chip}`
}

/** Whether an archive name (without `.tar.gz`) is for `chip`, by the place
 *  archiveName puts the chip. */
export function isArchiveForChip(archive: string, chip: string): boolean {
  return (
    archive.startsWith('mikro-fw-') &&
    (archive.endsWith(`-${chip}`) || archive === `mikro-fw-${chip}-generic`)
  )
}

function readPackageJson(
  packageDir: string,
): {ok: true; value: PackageJson} | {ok: false; message: string} {
  const file = join(packageDir, 'package.json')
  try {
    return {ok: true, value: JSON.parse(readFileSync(file, 'utf8')) as PackageJson}
  } catch (e) {
    return {ok: false, message: `cannot read ${file}: ${(e as Error).message}`}
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `firmware` condition of each export entry, by key. An exports object
 *  whose keys are conditions, not subpaths, is the `.` entry. */
function firmwareTargets(exports: unknown): Map<string, unknown> {
  const targets = new Map<string, unknown>()
  if (!isObject(exports)) return targets
  const keys = Object.keys(exports)
  const entries =
    keys.length > 0 && keys.every((key) => !key.startsWith('.'))
      ? [['.', exports] as const]
      : Object.entries(exports)
  for (const [key, value] of entries) {
    if (isObject(value) && Object.hasOwn(value, 'firmware')) targets.set(key, value.firmware)
  }
  return targets
}

/** The package's `firmware` exports, and the ones that can't name a board. */
export function firmwareExports(packageDir: string): {
  entries: FirmwareExport[]
  problems: BoardProblem[]
} {
  const read = readPackageJson(packageDir)
  if (!read.ok) return {entries: [], problems: [{specifier: packageDir, message: read.message}]}
  const pkg = read.value
  const packageName = pkg.name ?? packageDir
  const entries: FirmwareExport[] = []
  const problems: BoardProblem[] = []
  for (const [key, target] of firmwareTargets(pkg.exports)) {
    const specifier = key === '.' ? packageName : `${packageName}/${key.replace(/^\.\//, '')}`
    if (key.includes('*')) {
      problems.push({
        specifier,
        message: `the "firmware" condition of "${key}" is under a pattern, which can't be listed; export each board by name`,
      })
    } else if (typeof target !== 'string') {
      problems.push({specifier, message: `the "firmware" condition of "${key}" is not a path`})
    } else {
      entries.push({key, specifier, target, file: resolve(packageDir, target)})
    }
  }
  return {entries, problems}
}

/** What a firmware.json says, or why it can't describe a board. */
export function readFirmwareJson(
  file: string,
):
  | {ok: true; value: Pick<BoardImage, 'name' | 'description' | 'chip' | 'version'>}
  | {ok: false; message: string} {
  if (!existsSync(file)) return {ok: false, message: `not built: ${file} does not exist`}
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return {ok: false, message: `${file} is not valid JSON: ${(e as Error).message}`}
  }
  const invalid = validate(FirmwareJson, json, '')
  if (invalid) {
    const {message, path} = invalid.error
    return {ok: false, message: `${file}${path ? ` (${path.slice(1)})` : ''}: ${message}`}
  }
  const value = json as {name: string; description?: string; chip: string; version: string}
  if (!BOARD_NAME_RE.test(value.name) || value.name.length > MAX_BOARD_NAME_LENGTH) {
    return {
      ok: false,
      message: `${file}: "${value.name}" is not a board name (at most ${MAX_BOARD_NAME_LENGTH} characters, the form of a package name with an optional /<board>)`,
    }
  }
  return {
    ok: true,
    value: {
      name: value.name,
      description: value.description,
      chip: value.chip,
      version: value.version,
    },
  }
}

/** The boards a package declares, and the `firmware` exports that aren't one
 *  (not built, or not a Mikro.js firmware.json). */
export function loadBoards(packageDir: string): {boards: BoardImage[]; problems: BoardProblem[]} {
  const {entries, problems} = firmwareExports(packageDir)
  const read = readPackageJson(packageDir)
  const packageName = (read.ok ? read.value.name : undefined) ?? packageDir
  const boards: BoardImage[] = []
  for (const {key, specifier, file} of entries) {
    const read = readFirmwareJson(file)
    if (read.ok) {
      boards.push({...read.value, specifier, key, packageName, packageDir, dir: dirname(file)})
    } else {
      problems.push({specifier, message: read.message})
    }
  }
  return {boards, problems}
}

/** Whether npm publishes `path` (relative to the package) under this `files`
 *  list. Glob entries are taken as covering it: they need npm's matcher. */
function coveredByFiles(files: unknown, path: string): boolean {
  if (!Array.isArray(files)) return false
  return files.some((entry) => {
    if (typeof entry !== 'string') return false
    if (/[*?[{]/.test(entry)) return true
    const prefix = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return path === prefix || path.startsWith(`${prefix}/`)
  })
}

/**
 * Everything wrong with a board package's `firmware` exports, for
 * `mikro fw check` and `mikro fw prepack`: images missing or not parsing,
 * files flasher_args.json lists missing, images outside the package or not
 * published, two boards with one name, and `publishConfig.exports` pointing
 * elsewhere. Checks that depend on the CLI (the version it accepts, a newer
 * build) are the caller's.
 */
export function checkBoardPackage(packageDir: string): BoardProblem[] {
  const read = readPackageJson(packageDir)
  if (!read.ok) return [{specifier: packageDir, message: read.message}]
  const pkg = read.value
  const {entries} = firmwareExports(packageDir)
  const {boards, problems} = loadBoards(packageDir)
  const packageName = pkg.name ?? packageDir

  for (const {specifier, target, file} of entries) {
    const inPackage = relative(packageDir, dirname(file))
    if (inPackage.startsWith('..') || inPackage.startsWith(sep)) {
      problems.push({specifier, message: `${target} is outside the package`})
      continue
    }
    if (!coveredByFiles(pkg.files, inPackage.split(sep).join('/'))) {
      problems.push({
        specifier,
        message: `the image folder ${inPackage} is not in "files", so it isn't published`,
      })
    }
  }

  for (const board of boards) {
    const flasherArgs = join(board.dir, 'flasher_args.json')
    if (!existsSync(flasherArgs)) {
      problems.push({specifier: board.specifier, message: `${flasherArgs} does not exist`})
      continue
    }
    let flash: {flash_files?: Record<string, string>}
    try {
      flash = JSON.parse(readFileSync(flasherArgs, 'utf8')) as typeof flash
    } catch (e) {
      problems.push({
        specifier: board.specifier,
        message: `${flasherArgs} is not valid JSON: ${(e as Error).message}`,
      })
      continue
    }
    for (const file of Object.values(flash.flash_files ?? {})) {
      if (!existsSync(join(board.dir, file))) {
        problems.push({
          specifier: board.specifier,
          message: `${join(board.dir, file)} does not exist`,
        })
      }
    }
  }

  const byName = new Map<string, BoardImage>()
  for (const board of boards) {
    const other = byName.get(board.name)
    if (other) {
      problems.push({
        specifier: board.specifier,
        message: `${other.specifier} and ${board.specifier} are both named "${board.name}"`,
      })
    }
    byName.set(board.name, board)
  }

  if (pkg.publishConfig?.exports !== undefined) {
    const published = firmwareTargets(pkg.publishConfig.exports)
    const own = firmwareTargets(pkg.exports)
    for (const key of new Set([...own.keys(), ...published.keys()])) {
      if (own.get(key) !== published.get(key)) {
        problems.push({
          specifier: key === '.' ? packageName : `${packageName}/${key.replace(/^\.\//, '')}`,
          message: `the "firmware" condition of "${key}" differs between "exports" and "publishConfig.exports"`,
        })
      }
    }
  }
  return problems
}

/** The package root of @mikrojs/firmware: src/ or dist/ is one level down. */
const firmwarePackageDir = join(import.meta.dirname, '..')

/** The generic images @mikrojs/firmware ships, one per chip. In the
 *  repository they are not built; the release builds them. */
export function genericBoards(): {boards: BoardImage[]; problems: BoardProblem[]} {
  return loadBoards(firmwarePackageDir)
}
