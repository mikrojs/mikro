/**
 * Board packages: prebuilt firmware images that a package declares with a
 * `firmware` condition on its exports, pointing at the image's firmware.json:
 *
 *   "./t-display": {"firmware": "./dist-fw/t-display/full/firmware.json", "default": "./dist/t-display/index.js"}
 *
 * The image folder holds what `mikro fw prepack` copies out of a build:
 * firmware.json (written by the mikrojs component's CMake), flasher_args.json
 * and the files it lists. When the image folder is `full/`, the board's other
 * images (`no-ble`) sit in folders beside it, one image per folder, each with
 * a firmware.json of its own. A board names itself: the name in firmware.json is
 * the name its firmware reports as sys.board.name. A `firmware` target counts
 * as a board only if its firmware.json parses, so another tool's `firmware`
 * condition is reported, not taken for a board.
 *
 * The generic images are boards too, in mikro (`mikro/esp32c6-generic`).
 *
 * The package's boards.config.ts says what `mikro fw prepack` builds; its
 * exports must match it (checkBoardsConfig). Apps never read the config.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path'

import {array, enumOf, object, optional, string, validate} from '@mikrojs/schema'

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
  /** The features the image has (`wifi`, `ble`, …); absent in images from
   *  before firmware.json listed them. */
  features?: string[]
  /** The board's other images, besides this full one: the folders beside
   *  `dir` (when it is `full/`) whose firmware.json names the same board. */
  images?: ImageInfo[]
}

/** One of a board's images besides the full one. */
export interface ImageInfo {
  /** `no-ble`, `no-ble+no-wifi`: what it leaves out or adds. */
  name: string
  features: string[]
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
  features: optional(array(string())),
})

/** An image name: what it leaves out (`no-ble`) or adds, joined with `+`. */
const IMAGE_NAME_RE = /^(no-)?[a-z0-9]+(\+(no-)?[a-z0-9]+)*$/

/** The full image's folder in the board's, and its name for `--features`. */
export const FULL_IMAGE = 'full'

interface PackageJson {
  name?: string
  description?: string
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

/** Whether an archive name (without `.tar.gz`) is a full image for `chip`, by
 *  the place archiveName puts the chip. A board's other images (`+no-ble`)
 *  are only ever asked for by name. */
export function isArchiveForChip(archive: string, chip: string): boolean {
  return (
    archive.startsWith('mikro-fw-') &&
    !archive.includes('+') &&
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
export function readFirmwareJson(file: string):
  | {
      ok: true
      value: Pick<BoardImage, 'name' | 'description' | 'chip' | 'version' | 'features'>
    }
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
  const value = json as {
    name: string
    description?: string
    chip: string
    version: string
    features?: string[]
  }
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
      features: value.features,
    },
  }
}

/** A board's other images: the folders beside its full image's `full/`
 *  folder, named like an image, that hold an image of the same board. */
function siblingImages(dir: string, name: string, chip: string): ImageInfo[] | undefined {
  if (basename(dir) !== FULL_IMAGE) return undefined
  const boardDir = dirname(dir)
  const images: ImageInfo[] = []
  for (const entry of readdirSync(boardDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === FULL_IMAGE || !IMAGE_NAME_RE.test(entry.name)) {
      continue
    }
    const read = readFirmwareJson(join(boardDir, entry.name, 'firmware.json'))
    if (!read.ok || read.value.name !== name || read.value.chip !== chip) continue
    images.push({
      name: entry.name,
      features: read.value.features ?? [],
      dir: join(boardDir, entry.name),
    })
  }
  return images.sort((a, b) => a.name.localeCompare(b.name))
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
      const dir = dirname(file)
      const images = siblingImages(dir, read.value.name, read.value.chip)
      boards.push({...read.value, images, specifier, key, packageName, packageDir, dir})
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
    for (const dir of [board.dir, ...(board.images ?? []).map((image) => image.dir)]) {
      const flasherArgs = join(dir, 'flasher_args.json')
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
        if (!existsSync(join(dir, file))) {
          problems.push({specifier: board.specifier, message: `${join(dir, file)} does not exist`})
        }
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

/** The chips a board can be built for, as a type: chips.json's list, which a
 *  test keeps this in step with. */
export const CHIPS = ['esp32', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32s3'] as const
export type Chip = (typeof CHIPS)[number]

/** The features an image can leave out or add, and the ESP-IDF setting that
 *  switches each. */
const FEATURE_SETTINGS = {ble: 'CONFIG_BT_ENABLED', wifi: 'CONFIG_MIKROJS_WIFI'} as const

/** A feature an image can leave out or add. */
export type Feature = keyof typeof FEATURE_SETTINGS

/** An image of a board besides the full one: features switched off (`false`)
 *  or on (`true`) compared with the full image. */
export type ImageFeatures = Partial<Record<Feature, boolean>>

/** An image's name: `{ble: false}` is `no-ble`, `{ble: false, wifi: false}`
 *  is `no-ble+no-wifi`, a feature switched on is its own name. */
export function imageName(features: ImageFeatures): string {
  return Object.entries(features)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([feature, on]) => (on ? feature : `no-${feature}`))
    .join('+')
}

/** A board in boards.config.ts. Paths are relative to the package. */
export interface BoardConfig {
  /** The chip the board is built around. */
  chip: Chip
  /** The name the firmware reports as sys.board.name. Default: the specifier
   *  of the board's export (`@acme/devboard`, `@acme/boards/t-display`). */
  name?: string
  /** Shown when `mikro flash` asks which board to flash. Default: the
   *  package's description. */
  description?: string
  /** ESP-IDF settings (sdkconfig fragments), applied after the firmware's own. */
  sdkconfig?: string | readonly string[]
  /** A partition table (CSV) to use instead of the firmware's. */
  partitions?: string
  /** Native modules to compile in, by the specifiers apps import. */
  nativeModules?: readonly string[]
  /** A firmware project (a folder with a CMakeLists.txt) to build instead of
   *  the one `mikro fw prepack` generates. It brings its own settings,
   *  partition table and native modules. */
  project?: string
  /** Images to build besides the full one, each with features switched off
   *  or on: `[{ble: false}, {ble: false, wifi: false}]`. */
  images?: readonly ImageFeatures[]
}

/** boards.config.ts: the boards a package builds, keyed by the export that
 *  declares each, `.` or `./<board>`. */
export interface BoardsConfig {
  /** Where the images go, relative to the package: `<dist>/full/` for the
   *  board at `.`, `<dist>/<board>/full/` for the others, and each other image
   *  in a folder beside `full/`. Default: `dist-fw`. */
  dist?: string
  boards: Record<string, BoardConfig>
}

/** A board from boards.config.ts, with defaults filled in and paths resolved. */
export interface ConfiguredBoard {
  /** The export key: `.`, `./t-display`. */
  key: string
  specifier: string
  name: string
  description?: string
  chip: Chip
  /** Absolute paths. */
  sdkconfig: string[]
  partitions?: string
  nativeModules: string[]
  project?: string
  /** The `firmware` target the board's export must have: `./dist-fw/t-display/full/firmware.json`. */
  target: string
  /** The board's folder: the full image in `full/`, the others beside it.
   *  `mikro fw prepack` replaces it whole. */
  boardDir: string
  /** The images besides the full one. */
  images: ConfiguredImage[]
}

/** An image from `images` in boards.config.ts. */
export interface ConfiguredImage {
  /** `no-ble`: the image's folder in the board's, and its name everywhere else. */
  name: string
  features: ImageFeatures
  /** The sdkconfig lines that switch its features. */
  settings: string[]
  dir: string
}

const DEFAULT_DIST = 'dist-fw'
const BOARD_KEYS = [
  'chip',
  'name',
  'description',
  'sdkconfig',
  'partitions',
  'nativeModules',
  'project',
  'images',
]
/** `./<board>`: one segment, in the form of a board name's last part. */
const SUBPATH_RE = /^\.\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/** The exports block that declares `boards`, for messages. */
function exportsSnippet(boards: ConfiguredBoard[]): string {
  return boards.map((b) => `  "${b.key}": {"firmware": "${b.target}"}`).join(',\n')
}

/**
 * The boards in a package's boards.config.ts (`config`, its default export),
 * and everything wrong with it: fields that don't check out, files it names
 * that don't exist, names a device can't take, and `exports` that don't match
 * (a board without its `firmware` export, one pointing elsewhere, or a
 * `firmware` export the config doesn't have).
 */
export function checkBoardsConfig(
  packageDir: string,
  config: unknown,
): {boards: ConfiguredBoard[]; problems: BoardProblem[]} {
  const read = readPackageJson(packageDir)
  if (!read.ok) return {boards: [], problems: [{specifier: packageDir, message: read.message}]}
  const pkg = read.value
  const packageName = pkg.name ?? packageDir
  const problems: BoardProblem[] = []
  // Stops at a problem that leaves nothing to check, keeping the ones found so far
  const fail = (message: string) => ({
    boards: [],
    problems: [...problems, {specifier: packageName, message}],
  })
  if (pkg.name === undefined) return fail('package.json has no "name"')
  if (!isObject(config))
    return fail('boards.config.ts must export default defineBoards({boards: {...}})')
  for (const key of Object.keys(config)) {
    if (key !== 'dist' && key !== 'boards') {
      problems.push({specifier: packageName, message: `boards.config.ts: unknown field "${key}"`})
    }
  }
  const dist = config.dist ?? DEFAULT_DIST
  if (typeof dist !== 'string' || dist === '' || isAbsolute(dist)) {
    return fail('boards.config.ts: "dist" must be a folder in the package')
  }
  const distDir = resolve(packageDir, dist)
  const distInPackage = relative(packageDir, distDir)
  if (distInPackage === '' || distInPackage.startsWith('..')) {
    return fail('boards.config.ts: "dist" must be a folder in the package')
  }
  const distPath = distInPackage.split(sep).join('/')
  if (!isObject(config.boards) || Object.keys(config.boards).length === 0) {
    return fail('boards.config.ts: "boards" must name at least one board')
  }
  const keys = Object.keys(config.boards)
  if (keys.includes('.') && keys.length > 1) {
    return fail(
      'boards.config.ts: a package has one board at "." or boards at "./<board>", not both',
    )
  }

  const boards: ConfiguredBoard[] = []
  for (const [key, board] of Object.entries(config.boards)) {
    const sub = key.slice(2)
    const specifier = key === '.' ? packageName : `${packageName}/${sub}`
    const at = `boards.config.ts, board "${key}"`
    const problem = (message: string) => problems.push({specifier, message: `${at}: ${message}`})
    if (key !== '.' && !SUBPATH_RE.test(key)) {
      problem('a board is "." or "./<board>", lowercase letters, digits, "." and "-"')
      continue
    }
    if (!isObject(board)) {
      problem('expected an object')
      continue
    }
    for (const field of Object.keys(board)) {
      if (!BOARD_KEYS.includes(field)) problem(`unknown field "${field}"`)
    }
    const {chip, name, description, sdkconfig, partitions, nativeModules, project, images} = board
    if (typeof chip !== 'string' || !chips.includes(chip)) {
      problem(`"chip" must be one of ${chips.join(', ')}`)
      continue
    }
    if (name !== undefined && typeof name !== 'string') problem('"name" must be a string')
    if (description !== undefined && typeof description !== 'string') {
      problem('"description" must be a string')
    }
    if (sdkconfig !== undefined && typeof sdkconfig !== 'string' && !isStringArray(sdkconfig)) {
      problem('"sdkconfig" must be a path or a list of paths')
    }
    if (partitions !== undefined && typeof partitions !== 'string') {
      problem('"partitions" must be a path')
    }
    if (nativeModules !== undefined && !isStringArray(nativeModules)) {
      problem('"nativeModules" must be a list of import specifiers')
    }
    if (project !== undefined && typeof project !== 'string') problem('"project" must be a path')
    if (
      typeof project === 'string' &&
      (sdkconfig !== undefined || partitions !== undefined || nativeModules !== undefined)
    ) {
      problem(
        'a board with "project" takes its settings, partition table and native modules from ' +
          'that project; leave out "sdkconfig", "partitions" and "nativeModules"',
      )
    }
    const configuredImages: ConfiguredImage[] = []
    if (images !== undefined) {
      if (!Array.isArray(images)) problem('"images" must be a list, like [{ble: false}]')
      else if (typeof project === 'string') {
        problem('a board with "project" builds one image; leave out "images"')
      } else {
        for (const features of images as unknown[]) {
          const entries = isObject(features) ? Object.entries(features) : []
          if (
            entries.length === 0 ||
            !entries.every(
              ([f, on]) => Object.hasOwn(FEATURE_SETTINGS, f) && typeof on === 'boolean',
            )
          ) {
            problem(
              `each image switches features off or on, like {ble: false}; the features are ` +
                `${Object.keys(FEATURE_SETTINGS).join(', ')}`,
            )
            continue
          }
          const imageFeatures = features as ImageFeatures
          const image = imageName(imageFeatures)
          if (configuredImages.some((other) => other.name === image)) {
            problem(`two images are ${image}`)
            continue
          }
          configuredImages.push({
            name: image,
            features: imageFeatures,
            settings: entries.map(
              ([f, on]) => `${FEATURE_SETTINGS[f as Feature]}=${on === true ? 'y' : 'n'}`,
            ),
            dir: '',
          })
        }
      }
    }
    const files = [
      ...(typeof sdkconfig === 'string' ? [sdkconfig] : isStringArray(sdkconfig) ? sdkconfig : []),
      ...(typeof partitions === 'string' ? [partitions] : []),
      ...(typeof project === 'string' ? [join(project, 'CMakeLists.txt')] : []),
    ]
    for (const file of files) {
      if (!existsSync(resolve(packageDir, file))) problem(`${file} does not exist`)
    }
    const boardName = typeof name === 'string' ? name : specifier
    if (!BOARD_NAME_RE.test(boardName) || boardName.length > MAX_BOARD_NAME_LENGTH) {
      problem(
        `"${boardName}" is not a board name (at most ${MAX_BOARD_NAME_LENGTH} characters, the ` +
          'form of a package name with an optional /<board>)' +
          (typeof name === 'string' ? '' : '; set "name"'),
      )
    }
    const target = `./${distPath}/${key === '.' ? '' : `${sub}/`}${FULL_IMAGE}/firmware.json`
    const boardDir = key === '.' ? distDir : join(distDir, sub)
    boards.push({
      key,
      specifier,
      name: boardName,
      description: typeof description === 'string' ? description : pkg.description,
      chip: chip as Chip,
      sdkconfig: (typeof sdkconfig === 'string'
        ? [sdkconfig]
        : isStringArray(sdkconfig)
          ? sdkconfig
          : []
      ).map((file) => resolve(packageDir, file)),
      partitions: typeof partitions === 'string' ? resolve(packageDir, partitions) : undefined,
      nativeModules: isStringArray(nativeModules) ? nativeModules : [],
      project: typeof project === 'string' ? resolve(packageDir, project) : undefined,
      target,
      boardDir,
      images: configuredImages.map((image) => ({...image, dir: join(boardDir, image.name)})),
    })
  }

  const byName = new Map<string, ConfiguredBoard>()
  for (const board of boards) {
    const other = byName.get(board.name)
    if (other) {
      problems.push({
        specifier: board.specifier,
        message: `boards.config.ts: boards "${other.key}" and "${board.key}" are both named "${board.name}"`,
      })
    }
    byName.set(board.name, board)
  }

  // The exports must declare exactly the configured boards, where the config
  // puts their images.
  const targets = firmwareTargets(pkg.exports)
  const missing = boards.filter((board) => {
    const target = targets.get(board.key)
    return (
      typeof target !== 'string' ||
      resolve(packageDir, target) !== resolve(packageDir, board.target)
    )
  })
  for (const board of missing) {
    const target = targets.get(board.key)
    problems.push({
      specifier: board.specifier,
      message:
        target === undefined
          ? `"exports" has no "firmware" condition for "${board.key}"`
          : `the "firmware" condition of "${board.key}" is ${JSON.stringify(target)}, but boards.config.ts puts the image at "${board.target}"`,
    })
  }
  for (const key of targets.keys()) {
    if (!Object.hasOwn(config.boards, key)) {
      problems.push({
        specifier: key === '.' ? packageName : `${packageName}/${key.replace(/^\.\//, '')}`,
        message: `"${key}" has a "firmware" condition in "exports", but boards.config.ts has no board "${key}"`,
      })
    }
  }
  if (missing.length > 0) {
    problems.push({
      specifier: packageName,
      message: `add these to "exports" in package.json (next to any other conditions of the same export):\n${exportsSnippet(missing)}`,
    })
  }
  return {boards, problems}
}
