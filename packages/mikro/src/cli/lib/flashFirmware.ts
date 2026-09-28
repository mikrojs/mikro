import {createHash} from 'node:crypto'
import {existsSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {getEsptoolPath} from '@mikrojs/esptool'
import {FULL_IMAGE, readFirmwareJson} from '@mikrojs/firmware/boards'
import {lastValueFrom} from 'rxjs'

import {type BoardInfo, bundledBoards, discoverBoards, staleImage} from './boards.js'
import {didYouMean} from './didYouMean.js'
import {paths} from './envPaths.js'
import {UserError} from './errorMessage.js'
import {
  type FlasherArgs,
  type FlashSize,
  getWriteFlashMultiArgs,
  readFlasherArgs,
} from './esptool.js'
import {type Chip, resolveFrom} from './firmware.js'
import {formatSize} from './formatSize.js'
import {ospawn} from './ospawn.js'
import {
  filesystemLoss,
  growFilesystemToFlash,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
  userSize,
} from './partitionTable.js'

export const DEFAULT_FLASH_BAUD = 460800

export interface FlashPlanOptions {
  /** Serial port of the device to flash. */
  port: string
  /** Local ESP-IDF build directory. Mutually exclusive with `from`. */
  buildDir?: string
  /** URL of a firmware archive, as `mikro fw pack` writes it. Mutually
   *  exclusive with `buildDir`. */
  from?: string
  /** Board name; auto-discovered from project dependencies if omitted. */
  board?: string
  /** Board from mikro.config.ts, used when no `board` flag is given. */
  configBoard?: string
  /** The device's chip (`--chip`); detected via esptool if omitted. */
  chip?: Chip
  /** Let several installed boards for the device's chip come back as a
   *  BoardChoice, for a picker. Otherwise (headless) the plan stops and lists
   *  them. */
  pickBoard?: boolean
  /** `--features`: features the image must have (`wifi`), for the leanest of
   *  the board's images with them all; `no-<feature>` for the full image
   *  without that feature; or `full` for the full image. */
  features?: string[]
  /** The features the device's firmware reports, so a reflash keeps the image
   *  it runs when `features` doesn't pick one. */
  deviceFeatures?: string[]
  /** Progress callback for the resolution/flash phases. */
  onProgress?: (message: string) => void
}

/** How the flash plan's board was chosen. */
export type BoardSource = 'flag' | 'config' | 'dependency' | 'chip' | 'picked' | 'detected'

export interface FlashPlan {
  esptoolPath: string
  flasherArgs: FlasherArgs
  /** Where the image comes from: a local build, a download, a board
   *  package's image, or the generic image bundled with this CLI. */
  image: 'build-dir' | 'from' | 'board' | 'bundled'
  /** The board flashed and how it was chosen. Absent for `--build-dir`
   * flashes, which take the build as-is. */
  board?: {name: string; source: BoardSource}
  /** The board's image, when it isn't the full one by default: the leanest
   *  with the `--features` asked for, or the one the device runs now. */
  chosenImage?: ImageChoice
  /** Shown before the go-ahead; none stops the flash: the board's image is
   *  older than its build, or a dependency's `firmware` export was skipped. */
  warnings: string[]
  /** The device's partition table, when the plan has read it. */
  devicePartitionTable?: Uint8Array
  /** Size of the app filesystem (`user` partition) the firmware will have. */
  filesystemSize?: number
}

/** An image of a board picked by `--features`, or by what the device runs. */
export interface ImageChoice {
  name: string
  source: 'features' | 'device'
}

/** Several installed boards for the device's chip, and nothing choosing
 *  between them: the interactive `mikro flash` offers a picker. */
export interface BoardChoice {
  choose: BoardInfo[]
}

/** The outcome of looking for the board to flash. `warnings` name the
 *  dependencies' `firmware` exports that aren't usable boards: they are
 *  skipped, never a reason to stop. */
export type BoardDiscovery = {warnings: string[]} & (
  | {kind: 'board'; board: BoardInfo; source: BoardSource}
  | {kind: 'choose'; boards: BoardInfo[]}
  | {kind: 'unknown'; name: string; source: BoardSource; known: string[]}
  | {kind: 'none'}
)

function chooseMessage(boards: BoardInfo[], chip?: string): string {
  return (
    `Several boards${chip ? ` for ${chip}` : ''} are installed; choose one:\n` +
    boards.map((b) => `  mikro flash --board ${b.name}`).join('\n') +
    "\nor set board: '<name>' in mikro.config.ts."
  )
}

interface DeviceFlash {
  chip: Chip
  partitionTable: Uint8Array
  /** Physical flash size in bytes, when esptool recognised the flash chip. */
  flashSize?: number
}

/** Read the partition table of the device on `port` with `esptool read-flash`,
 *  which also reports the chip type and flash size. No `device` when esptool
 *  fails; `error` is then what esptool printed, such as a port another program
 *  holds. */
async function readDeviceFlash(
  esptoolPath: string,
  port: string,
): Promise<{device?: DeviceFlash; error?: Error}> {
  const {execFile} = await import('node:child_process')
  const {promisify} = await import('node:util')
  const execFileAsync = promisify(execFile)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mikro-flash-'))
  const file = path.join(dir, 'partition-table.bin')
  try {
    const {stdout} = await execFileAsync(esptoolPath, [
      '--port',
      port,
      'read-flash',
      '--flash-size',
      'detect',
      String(PARTITION_TABLE_OFFSET),
      String(PARTITION_TABLE_SIZE),
      file,
    ])
    // esptool's connect output contains "Detecting chip type... ESP32-C6" or similar
    const match = stdout.match(/Detecting chip type\.\.\.\s*(\S+)/i)
    if (!match) return {}
    // Absent when esptool falls back to 4MB ("Could not auto-detect flash size")
    const size = stdout.match(/Auto-detected flash size:\s*(\S+)/i)
    return {
      device: {
        chip: match[1]!.toLowerCase().replace(/-/g, ''),
        partitionTable: await fs.readFile(file),
        flashSize: size ? flashSizeBytes(size[1]!) : undefined,
      },
    }
  } catch (e) {
    const stderr = (e as {stderr?: unknown}).stderr
    return {
      error:
        typeof stderr === 'string' && stderr.trim()
          ? new Error(stderr.trim(), {cause: e})
          : (e as Error),
    }
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
}

/** Look for the board to flash. Precedence: `--board` flag > `config.board` >
 *  exactly one board in the project's dependencies; several are a `choose`
 *  that resolveFlashPlan narrows down to the device's chip (see boardForChip);
 *  none leaves the chip's bundled board to the caller. A board is found by the
 *  name its image reports, among the project's board packages and the bundled
 *  `<chip>-generic` boards. */
export async function discoverBoard(
  boardFlag: string | undefined,
  configBoard?: string,
  source: BoardSource = 'flag',
): Promise<BoardDiscovery> {
  const bundled = bundledBoards()
  // A bundled board needs no board package, so a broken one cannot block the
  // flash that recovers a device.
  const named = boardFlag ?? configBoard
  const namedSource = boardFlag ? source : 'config'
  const generic = bundled.find((b) => b.name === named)
  if (generic) return {kind: 'board', board: generic, source: namedSource, warnings: []}

  const {boards, problems} = await discoverBoards(process.cwd())
  const warnings = problems.map((p) => `skipped ${p.specifier}: ${p.message}`)
  if (named !== undefined) {
    const matches = boards.filter((b) => b.name === named)
    if (matches.length > 1) throw duplicateNameError(named, matches)
    if (matches.length === 1) {
      return {kind: 'board', board: matches[0]!, source: namedSource, warnings}
    }
    const known = [...boards, ...bundled].map((b) => b.name)
    return {kind: 'unknown', name: named, source: namedSource, known, warnings}
  }
  for (const [name, same] of Map.groupBy(boards, (b) => b.name)) {
    if (same.length > 1) throw duplicateNameError(name, same)
  }
  if (boards.length === 1) {
    return {kind: 'board', board: boards[0]!, source: 'dependency', warnings}
  }
  if (boards.length > 1) return {kind: 'choose', boards, warnings}
  return {kind: 'none', warnings}
}

function duplicateNameError(name: string, boards: BoardInfo[]): UserError {
  return new UserError(
    `Several installed boards are named '${name}': ${boards.map((b) => b.specifier).join(', ')}. ` +
      'Remove all but one from package.json.',
  )
}

function unknownBoardError(found: Extract<BoardDiscovery, {kind: 'unknown'}>): UserError {
  const suggestion = didYouMean(found.name, found.known)
  return new UserError(
    `Unknown board '${found.name}'.` +
      (suggestion === undefined ? '' : ` Did you mean '${suggestion}'?`) +
      `\nKnown boards: ${found.known.join(', ')}` +
      (found.warnings.length
        ? `\nNot usable:\n${found.warnings.map((w) => `  ${w}`).join('\n')}`
        : ''),
  )
}

/** Several boards installed and nothing naming one: the one for the device's
 *  chip. Several for that chip are the picker's to choose from, or listed
 *  when there is no picker; none is an error rather than the generic firmware,
 *  since the project depends on boards. A device too stuck to report its chip
 *  leaves every board to choose from. */
function boardForChip(
  boards: BoardInfo[],
  chip: Chip | undefined,
  opts: FlashPlanOptions,
): {board: BoardInfo; source: BoardSource} | BoardChoice {
  const {port, pickBoard} = opts
  if (chip === undefined) {
    if (pickBoard) return {choose: boards}
    throw new UserError(chooseMessage(boards))
  }
  const matches = boards.filter((b) => b.chip === chip)
  if (matches.length === 1) return {board: matches[0]!, source: 'chip'}
  if (matches.length === 0) {
    throw new UserError(
      `None of the installed boards is for the ${chip} on ${port}:\n` +
        boards.map((b) => `  ${b.name} (${b.chip})`).join('\n') +
        `\nPass --board ${chip}-generic to flash the generic firmware.`,
    )
  }
  if (pickBoard) return {choose: matches}
  throw new UserError(chooseMessage(matches, chip))
}

/** Hard-stop when the selected board doesn't match the connected chip.
 *  Detection failure is not an error here: a stuck device is exactly what
 *  `mikro flash` recovers, so the check only fires on a positive mismatch. */
function verifyBoardChip(port: string, board: BoardInfo, detected: Chip | undefined): void {
  if (detected !== undefined && detected !== board.chip) {
    throw new UserError(
      `${board.name} is an ${board.chip} board; the device on ${port} is an ${detected}. ` +
        `Pass --board ${detected}-generic, or change \`board\` in mikro.config.ts.`,
    )
  }
}

/**
 * The plan for `--from`: the firmware archive at a URL, flashed as it is but
 * fitted to the device's flash. The firmware of a Mikro.js version ships in
 * that version's mikro package instead, which `mikro flash` flashes.
 */
async function fromArchive(from: string, opts: FlashPlanOptions): Promise<FlashPlan> {
  if (!/^https?:\/\//.test(from)) {
    throw new UserError(
      `--from takes the URL of a firmware archive (a .tar.gz, as mikro fw pack writes it), ` +
        `not "${from}". The firmware of another Mikro.js version ships in that version's ` +
        `mikro package: install it and run mikro flash. Flash a local build with --build-dir.`,
    )
  }
  if (opts.board !== undefined || opts.features !== undefined) {
    throw new UserError(
      "--board and --features pick a board's image; --from flashes the archive at that URL as it is.",
    )
  }
  opts.onProgress?.('Resolving esptool…')
  const esptoolPath = await getEsptoolPath()
  // For fitToDeviceFlash and assertFilesystemKept, and to name a wrong chip
  // before esptool does
  opts.onProgress?.('Reading device flash…')
  const {device} = await readDeviceFlash(esptoolPath, opts.port)
  const firmwareDir = await resolveFrom(from, opts.onProgress)
  const archived = readFirmwareJson(path.join(firmwareDir, 'firmware.json'))
  const chip = opts.chip ?? device?.chip
  if (archived.ok && chip !== undefined && archived.value.chip !== chip) {
    throw new UserError(
      `${from} is firmware for ${archived.value.chip}, and the device is an ${chip}.`,
    )
  }
  const flasherArgs = await fitToDeviceFlash(await readFlasherArgs(firmwareDir), device)
  return withFilesystemSize({
    esptoolPath,
    flasherArgs,
    image: 'from',
    warnings: [],
    devicePartitionTable: device?.partitionTable,
  })
}

/** `--features` as a list of features: comma-separated, or joined with `+`
 *  as in image names (`no-ble+no-wifi`), where `min` asks for none of them,
 *  so the leanest image. */
export function parseFeatures(value: string): string[] {
  return value
    .split(/[,+]/)
    .map((f) => f.trim())
    .filter((f) => f !== '' && f !== 'min')
}

/** A board's images, the full one first. */
function boardImages(board: BoardInfo & {dir: string}) {
  return [{name: FULL_IMAGE, dir: board.dir, features: board.features}, ...(board.images ?? [])]
}

/**
 * The leanest of `images` (the full one first) with every feature in
 * `wanted`; `full` asks for the full image. Undefined when none has them all.
 */
function leanestImage<I extends {name: string; features?: string[]}>(
  images: I[],
  wanted: string[],
): I | undefined {
  const full = images[0]!
  if (wanted.includes(FULL_IMAGE)) return full
  // A full image from before firmware.json listed features has them all
  const has = (i: I) =>
    i.features === undefined ? i === full : wanted.every((f) => i.features!.includes(f))
  return images
    .filter(has)
    .sort((a, b) => (a.features?.length ?? Infinity) - (b.features?.length ?? Infinity))[0]
}

/** The images of a board with their features, for an error. */
function listImages(images: {name: string; features?: string[]}[]): string {
  return (
    `\nIts images: ` +
    images.map((i) => `${i.name} (${i.features?.join(', ') ?? 'every feature'})`).join(', ')
  )
}

/** The error for features the firmware has no image with. */
function lackingError(
  boardName: string,
  images: {name: string; features?: string[]}[],
  lacking: string[],
  known: string[],
): UserError {
  const hint = lacking.length === 1 ? didYouMean(lacking[0]!, known) : undefined
  return new UserError(
    `${boardName}'s firmware has no ${lacking.join(', ')}.` +
      (hint === undefined ? '' : ` Did you mean ${hint}?`) +
      listImages(images),
  )
}

/**
 * The image `--features` asks for: the leanest with them all. Each image is
 * the full one without some features, so none fits only when the firmware
 * lacks one of them, which is an error that names it.
 */
function imageWithFeatures<I extends {name: string; features?: string[]}>(
  boardName: string,
  images: I[],
  wanted: string[],
): I {
  const without = wanted.filter((f) => f.startsWith('no-')).map((f) => f.slice(3))
  if (without.length > 0) return imageWithout(boardName, images, wanted, without)
  const leanest = leanestImage(images, wanted)
  if (leanest !== undefined) return leanest
  const known = images[0]!.features ?? []
  throw lackingError(
    boardName,
    images,
    wanted.filter((f) => !known.includes(f)),
    known,
  )
}

/**
 * The image `--features no-<feature>` asks for: one without the features
 * named that has every other feature of the full image, and any asked for,
 * the leanest if several do.
 */
function imageWithout<I extends {name: string; features?: string[]}>(
  boardName: string,
  images: I[],
  wanted: string[],
  without: string[],
): I {
  // An image can also add a feature the full one lacks (`{ble: true}`)
  const known = [...new Set(images.flatMap((i) => i.features ?? []))]
  const asked = [
    ...new Set([
      ...(images[0]!.features ?? []).filter((f) => !without.includes(f)),
      ...wanted.filter((f) => !f.startsWith('no-') && f !== FULL_IMAGE),
    ]),
  ]
  const lacking = [...asked, ...without].filter((f) => !known.includes(f))
  if (lacking.length > 0) throw lackingError(boardName, images, lacking, known)
  // A full image that lists no features has them all
  const candidates = images.filter((i) => !without.some((f) => i.features?.includes(f) ?? true))
  const image = candidates.length === 0 ? undefined : leanestImage(candidates, asked)
  if (image !== undefined) return image
  const withAsked = asked.length === 0 ? '' : `with ${asked.join(', ')} and `
  throw new UserError(
    `${boardName} has no image ${withAsked}without ${without.join(', ')}.${listImages(images)}`,
  )
}

/**
 * The image of `board` to flash: the leanest with every feature in `wanted`
 * (`--features`), else the leanest with every feature the device reports, so
 * a reflash keeps what the device runs even when a new version's images gain a
 * feature, else the full image.
 */
export function chooseImage(
  board: BoardInfo & {dir: string},
  wanted: string[] | undefined,
  deviceFeatures: string[] | undefined,
): {dir: string; chosenImage?: ImageChoice} {
  if (wanted !== undefined) {
    const image = imageWithFeatures(board.name, boardImages(board), wanted)
    return {dir: image.dir, chosenImage: {name: image.name, source: 'features'}}
  }
  if (deviceFeatures === undefined || board.images === undefined) return {dir: board.dir}
  // Undefined when the device has a feature none of these images has: the full image
  const running = leanestImage(boardImages(board), deviceFeatures)
  return running === undefined || running.name === FULL_IMAGE
    ? {dir: board.dir}
    : {dir: running.dir, chosenImage: {name: running.name, source: 'device'}}
}

/**
 * Resolve everything needed to flash, without running esptool: the esptool
 * binary plus the per-chip flasher arguments (firmware files, flash mode,
 * etc.). Mirrors the source modes of `mikro flash`:
 *   - `buildDir`: a local ESP-IDF build
 *   - `from`: a firmware archive, downloaded from its URL
 *   - neither: the image the board package ships, or else the generic
 *     prebuilt bundled with this CLI version
 */
export async function resolveFlashPlan(
  opts: FlashPlanOptions & {
    /** How an explicit `board` was chosen; `flag` unless a picker supplied it. */
    boardSource?: BoardSource
  },
): Promise<FlashPlan | BoardChoice> {
  const {port, buildDir, from, board: boardFlag, configBoard, chip, onProgress} = opts

  if (buildDir) {
    if (opts.features !== undefined) {
      throw new UserError(
        '--features picks an image of a board; --build-dir flashes a build as it is.',
      )
    }
    const [flasherArgs, esptoolPath] = await Promise.all([
      readFlasherArgs(buildDir),
      getEsptoolPath(),
    ])
    return withFilesystemSize({esptoolPath, flasherArgs, image: 'build-dir', warnings: []})
  }

  if (from !== undefined) return fromArchive(from, opts)

  onProgress?.('Resolving esptool…')
  const esptoolPath = await getEsptoolPath()
  const found = await discoverBoard(boardFlag, configBoard, opts.boardSource ?? 'flag')
  const warnings = [...found.warnings]
  if (found.kind === 'unknown') throw unknownBoardError(found)
  // One esptool session gives the chip, the partition table for
  // assertFilesystemKept, and the flash size for fitToDeviceFlash.
  onProgress?.(chip ? 'Reading device flash…' : 'Detecting chip…')
  const {device, error: deviceError} = await readDeviceFlash(esptoolPath, port)
  let resolved: {board: BoardInfo; source: BoardSource} | undefined
  if (found.kind === 'board') {
    resolved = {board: found.board, source: found.source}
  } else if (found.kind === 'choose') {
    const chosen = boardForChip(found.boards, chip ?? device?.chip, opts)
    if ('choose' in chosen) return chosen
    resolved = chosen
  }

  if (resolved && chip && chip !== resolved.board.chip) {
    throw new UserError(
      `${resolved.board.name} is an ${resolved.board.chip} board, but --chip is ${chip}. ` +
        `Drop --chip, or pass a board for that chip.`,
    )
  }
  // esptool refuses firmware for another chip by itself, but only after the
  // firmware is resolved (and perhaps downloaded), and with its own message.
  // Checking first names the board that is wrong.
  if (resolved && resolved.source !== 'chip') verifyBoardChip(port, resolved.board, device?.chip)

  const resolvedChip = chip ?? resolved?.board.chip ?? device?.chip
  if (!resolvedChip) {
    throw new UserError(
      deviceError
        ? 'Could not detect chip type'
        : 'Could not detect chip type. Use --chip to name it (e.g. --chip esp32c6).',
      {cause: deviceError},
    )
  }
  const devicePartitionTable = device?.partitionTable

  // No board selected: the bundled board for the chip --chip names, or the detected one.
  resolved ??= {
    board: bundledBoards().find((b) => b.chip === resolvedChip) ?? {
      name: `${resolvedChip}-generic`,
      chip: resolvedChip,
      bundled: true,
    },
    source: 'detected',
  }
  const boardInfo = {name: resolved.board.name, source: resolved.source}

  if (resolved.board.dir === undefined) {
    throw new UserError(
      `No bundled firmware for ${resolvedChip}. ` +
        `Build a custom firmware locally and flash it with --build-dir.`,
    )
  }
  const {dir, chosenImage} = chooseImage(
    {...resolved.board, dir: resolved.board.dir},
    opts.features,
    opts.deviceFeatures,
  )
  if (!existsSync(path.join(dir, 'flasher_args.json'))) {
    throw new UserError(
      `The image of ${resolved.board.name} in ${dir} is incomplete: flasher_args.json is missing. ` +
        'Run `mikro fw build` in its package.',
    )
  }
  const flasherArgs = await fitToDeviceFlash(await readFlasherArgs(dir), device)
  const stale = staleImage(resolved.board)
  if (stale) warnings.push(stale)
  return withFilesystemSize({
    esptoolPath,
    flasherArgs,
    image: resolved.board.bundled ? 'bundled' : 'board',
    board: boardInfo,
    chosenImage,
    warnings,
    devicePartitionTable,
  })
}

/** ESP-IDF needs 32-bit flash addressing above 16 MB, which the generic
 *  firmware isn't built with. */
const MAX_FLASH_SIZE = 16 * 1024 * 1024

/** Stretch a last `user` partition to the end of the device's flash, and write
 *  the bootloader with that size: its header caps what ESP-IDF will access. */
async function fitToDeviceFlash(
  flasherArgs: FlasherArgs,
  device: DeviceFlash | undefined,
): Promise<FlasherArgs> {
  const table = flasherArgs.files.find((f) => f.address === PARTITION_TABLE_OFFSET)
  if (!device?.flashSize || !table) return flasherArgs
  const flashSize = Math.min(device.flashSize, MAX_FLASH_SIZE)
  const grown = growFilesystemToFlash(await fs.readFile(table.filename), flashSize)
  if (!grown) return flasherArgs

  // Named by content in the user's own cache, so repeated flashes reuse one file.
  const hash = createHash('sha256').update(grown).digest('hex').slice(0, 16)
  const dir = path.join(paths.cache, 'partition-tables')
  await fs.mkdir(dir, {recursive: true})
  const filename = path.join(dir, `${hash}.bin`)
  await fs.writeFile(filename, grown)
  return {
    ...flasherArgs,
    flashSize: `${flashSize / (1024 * 1024)}MB` as FlashSize,
    files: flasherArgs.files.map((f) => (f === table ? {...f, filename} : f)),
  }
}

async function withFilesystemSize(plan: FlashPlan): Promise<FlashPlan> {
  const table = plan.flasherArgs.files.find((f) => f.address === PARTITION_TABLE_OFFSET)
  if (!table) return plan
  return {...plan, filesystemSize: userSize(await fs.readFile(table.filename))}
}

/** Bytes in an esptool flash size such as "4MB" or "512KB"; undefined for
 *  "keep", "detect" and anything else. */
function flashSizeBytes(size: string): number | undefined {
  const match = size.match(/^(\d+)(KB|MB)$/)
  if (!match) return undefined
  return Number(match[1]) * (match[2] === 'MB' ? 1024 * 1024 : 1024)
}

/**
 * Refuse a flash whose partition table drops, moves or shrinks the app
 * filesystem: the firmware then reformats it and the app's files are lost.
 * A device esptool cannot read passes: recovering such devices is what
 * `mikro flash` is for.
 */
export async function assertFilesystemKept(
  plan: FlashPlan,
  port: string,
  override = 'Re-run with --force to flash anyway.',
): Promise<void> {
  const next = plan.flasherArgs.files.find((f) => f.address === PARTITION_TABLE_OFFSET)
  if (!next) return
  const current =
    plan.devicePartitionTable ??
    (await readDeviceFlash(plan.esptoolPath, port)).device?.partitionTable
  if (!current) return
  const loss = filesystemLoss(current, await fs.readFile(next.filename))
  if (!loss) return
  const {from, to} = loss
  const change = !to
    ? `This firmware's partition table has no app filesystem (the device has ${formatSize(from.size)}).`
    : to.offset !== from.offset
      ? `This firmware moves the app filesystem from 0x${from.offset.toString(16)} to ` +
        `0x${to.offset.toString(16)}.`
      : `This firmware shrinks the app filesystem from ${formatSize(from.size)} to ` +
        `${formatSize(to.size)}, ${formatSize(from.size - to.size)} less.`
  throw new UserError(
    `${change} The filesystem would be reformatted and the app's files on it lost. ${override}`,
  )
}

/**
 * Resolve and flash firmware to completion, headlessly. Resolves on success,
 * rejects with the esptool failure on error. The serial port must be free
 * (no open session) before calling — esptool needs exclusive bootloader
 * access. Used by the auto-reflash flow; the interactive `mikro flash`
 * command renders its own live progress and only shares `resolveFlashPlan`.
 *
 * It only installs the generic firmware bundled with this CLI. A board
 * package's image (whose version is not checked) is left to `mikro flash`,
 * which shows what it will flash and asks.
 */
export async function flashFirmware(
  opts: FlashPlanOptions & {baudRate?: number; signal?: AbortSignal},
): Promise<void> {
  const {port, baudRate = DEFAULT_FLASH_BAUD, onProgress, signal} = opts
  const plan = await resolveFlashPlan(opts)
  // Headless (no pickBoard): several boards for the chip already stopped the plan.
  if ('choose' in plan) throw new UserError(chooseMessage(plan.choose))
  const {esptoolPath, flasherArgs, image, board} = plan
  if (image === 'board') {
    throw new UserError(
      `${board!.name} ships firmware of its own, so it is not flashed automatically. ` +
        `Flash it with:\n  mikro flash --board ${board!.name}`,
    )
  }
  await assertFilesystemKept(plan, port, 'Run `mikro flash --force` to flash anyway.')

  onProgress?.(`Flashing ${flasherArgs.chip} firmware…`)
  const esptoolArgs = getWriteFlashMultiArgs({
    chip: flasherArgs.chip,
    port,
    baudRate,
    before: flasherArgs.before,
    after: flasherArgs.after,
    flashMode: flasherArgs.flashMode,
    flashSize: flasherArgs.flashSize,
    files: flasherArgs.files,
  })

  const final = await lastValueFrom(ospawn(esptoolPath, esptoolArgs, {signal}))
  if (signal?.aborted) throw new Error('Flashing aborted')
  if (final.error) throw final.error
}
