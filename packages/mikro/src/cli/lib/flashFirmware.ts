import {existsSync} from 'node:fs'
import * as path from 'node:path'

import {getEsptoolPath} from '@mikrojs/esptool'
import {readFirmwareJson} from '@mikrojs/firmware/boards'
import {lastValueFrom} from 'rxjs'

import {type BoardInfo, bundledBoards, discoverBoards, staleImage} from './boards.js'
import {didYouMean} from './didYouMean.js'
import {UserError} from './errorMessage.js'
import {type FlasherArgs, getWriteFlashMultiArgs, readFlasherArgs} from './esptool.js'
import {type Chip, resolveFrom} from './firmware.js'
import {ospawn} from './ospawn.js'

export const DEFAULT_FLASH_BAUD = 460800

export interface FlashPlanOptions {
  /** Serial port of the device to flash. */
  port: string
  /** Local ESP-IDF build directory. Mutually exclusive with `from`. */
  buildDir?: string
  /** Firmware source ref (release tag, branch, commit, repo, or archive URL). */
  from?: string
  /** Board name; auto-discovered from project dependencies if omitted. */
  board?: string
  /** Board from mikro.config.ts, used when no `board` flag is given. */
  configBoard?: string
  /** Target chip; auto-detected via esptool if omitted. */
  target?: Chip
  /** Let several installed boards for the device's chip come back as a
   *  BoardChoice, for a picker. Otherwise (headless) the plan stops and lists
   *  them. */
  pickBoard?: boolean
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
  /** Shown before the go-ahead; none stops the flash: the board's image is
   *  older than its build, or a dependency's `firmware` export was skipped. */
  warnings: string[]
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

/** Detect the chip type of the device on `port` via `esptool chip-id`. */
export async function detectChip(esptoolPath: string, port: string): Promise<Chip> {
  const {execFile} = await import('node:child_process')
  const {promisify} = await import('node:util')
  const execFileAsync = promisify(execFile)

  try {
    const {stdout} = await execFileAsync(esptoolPath, ['--port', port, 'chip-id'])

    // esptool chip_id output contains "Detecting chip type... ESP32-C6" or similar
    const match = stdout.match(/Detecting chip type\.\.\.\s*(\S+)/i)
    if (match) {
      return match[1]!.toLowerCase().replace(/-/g, '')
    }
  } catch {
    // Detection failed, fall through
  }

  throw new UserError(
    `Could not detect chip type. Use --target to specify the chip (e.g. --target esp32c6).`,
  )
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
async function boardForChip(
  boards: BoardInfo[],
  esptoolPath: string,
  opts: FlashPlanOptions,
): Promise<{board: BoardInfo; source: BoardSource} | BoardChoice> {
  const {port, target, pickBoard, onProgress} = opts
  let chip = target
  if (chip === undefined) {
    try {
      onProgress?.('Detecting chip…')
      chip = await detectChip(esptoolPath, port)
    } catch {
      if (pickBoard) return {choose: boards}
      throw new UserError(chooseMessage(boards))
    }
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
async function verifyBoardChip(
  esptoolPath: string,
  port: string,
  board: BoardInfo,
  onProgress?: (message: string) => void,
): Promise<void> {
  let detected: Chip
  try {
    onProgress?.('Detecting chip…')
    detected = await detectChip(esptoolPath, port)
  } catch {
    return
  }
  if (detected !== board.chip) {
    throw new UserError(
      `${board.name} is an ${board.chip} board; the device on ${port} is an ${detected}. ` +
        `Pass --board ${detected}-generic, or change \`board\` in mikro.config.ts.`,
    )
  }
}

/**
 * Resolve everything needed to flash, without running esptool: the esptool
 * binary plus the per-chip flasher arguments (firmware files, flash mode,
 * etc.). Mirrors the source modes of `mikro flash`:
 *   - `buildDir`: a local ESP-IDF build
 *   - `from`: a downloaded firmware ref
 *   - neither: the image the board package ships, or else the generic
 *     prebuilt bundled with this CLI version
 */
export async function resolveFlashPlan(
  opts: FlashPlanOptions & {
    /** How an explicit `board` was chosen; `flag` unless a picker supplied it. */
    boardSource?: BoardSource
  },
): Promise<FlashPlan | BoardChoice> {
  const {port, buildDir, from, board: boardFlag, configBoard, target, onProgress} = opts

  if (buildDir) {
    const [flasherArgs, esptoolPath] = await Promise.all([
      readFlasherArgs(buildDir),
      getEsptoolPath(),
    ])
    return {esptoolPath, flasherArgs, image: 'build-dir', warnings: []}
  }

  onProgress?.('Resolving esptool…')
  const esptoolPath = await getEsptoolPath()
  const found = await discoverBoard(boardFlag, configBoard, opts.boardSource ?? 'flag')
  const warnings = [...found.warnings]
  let resolved: {board: BoardInfo; source: BoardSource} | undefined
  // With --from, --board only picks an archive of the release or build, so it
  // needs no installed board of that name (custom firmware has none).
  let archiveBoard: {name: string; source: BoardSource} | undefined
  if (found.kind === 'board') {
    resolved = {board: found.board, source: found.source}
  } else if (found.kind === 'choose') {
    const chosen = await boardForChip(found.boards, esptoolPath, opts)
    if ('choose' in chosen) return chosen
    resolved = chosen
  } else if (found.kind === 'unknown') {
    if (!from) throw unknownBoardError(found)
    archiveBoard = {name: found.name, source: found.source}
  }

  if (resolved && target && target !== resolved.board.chip) {
    throw new UserError(
      `${resolved.board.name} is an ${resolved.board.chip} board, but --target is ${target}. ` +
        `Drop --target, or pass a board for that chip.`,
    )
  }
  // esptool refuses firmware for another chip by itself, but only after the
  // firmware is resolved (and perhaps downloaded), and with its own message.
  // Checking first costs one chip-id run and names the board that is wrong.
  if (resolved && resolved.source !== 'chip') {
    await verifyBoardChip(esptoolPath, port, resolved.board, onProgress)
  }

  let resolvedChip: Chip | undefined = target ?? resolved?.board.chip
  if (!resolvedChip) {
    onProgress?.('Detecting chip…')
    resolvedChip = await detectChip(esptoolPath, port)
  }

  if (from) {
    // No board named or found: the chip's bundled board, whose archive a release carries.
    const board = archiveBoard ?? {
      name: resolved?.board.name ?? `${resolvedChip}-generic`,
      source: resolved?.source ?? 'detected',
    }
    const firmwareDir = await resolveFrom({
      from,
      chip: resolvedChip,
      board: board.name,
      onProgress: (message) => onProgress?.(message),
    })
    const flasherArgs = await readFlasherArgs(firmwareDir)
    // A release without the board's archive falls back to the chip's: report
    // what was downloaded, not what was asked for.
    const archived = readFirmwareJson(path.join(firmwareDir, 'firmware.json'))
    if (archived.ok && archived.value.name !== board.name) {
      warnings.push(
        `${from} has no firmware for ${board.name}; this flashes ${archived.value.name}`,
      )
      return {
        esptoolPath,
        flasherArgs,
        image: 'from',
        board: {name: archived.value.name, source: 'detected'},
        warnings,
      }
    }
    return {esptoolPath, flasherArgs, image: 'from', board, warnings}
  }

  // No board selected: the detected (or --target) chip's bundled board.
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
        `Build a custom firmware locally and flash with --build-dir, ` +
        `or fetch a CI artifact with --from=mikrojs/mikro@<sha>.`,
    )
  }
  const {dir} = resolved.board
  if (!existsSync(path.join(dir, 'flasher_args.json'))) {
    throw new UserError(
      `The image of ${resolved.board.name} in ${dir} is incomplete: flasher_args.json is missing. ` +
        'Run `mikro fw prepack` in its firmware project.',
    )
  }
  const flasherArgs = await readFlasherArgs(dir)
  const stale = staleImage(resolved.board)
  if (stale) warnings.push(stale)
  return {
    esptoolPath,
    flasherArgs,
    image: resolved.board.bundled ? 'bundled' : 'board',
    board: boardInfo,
    warnings,
  }
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
