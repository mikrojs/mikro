import {getEsptoolPath} from '@mikrojs/esptool'
import {hasPrebuiltFirmware, prebuiltFirmwareDir} from '@mikrojs/firmware'
import {lastValueFrom} from 'rxjs'

import {type BoardInfo, discoverBoards, genericBoards} from './boards.js'
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
  /** Progress callback for the resolution/flash phases. */
  onProgress?: (message: string) => void
}

/** How the flash plan's board was chosen. */
export type BoardSource = 'flag' | 'config' | 'dependency' | 'detected'

export interface FlashPlan {
  esptoolPath: string
  flasherArgs: FlasherArgs
  /** The board flashed and how it was chosen. Absent for `--build-dir`
   * flashes, which take the build as-is. */
  board?: {name: string; source: BoardSource}
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

/** Resolve the board to flash. Precedence: `--board` flag > `config.board` >
 *  exactly one project board dependency > undefined (the caller falls
 *  back to chip detection and the chip's generic board). Named boards resolve
 *  against installed board packages first, then the synthesized
 *  `<chip>-generic` boards. */
export async function discoverBoard(
  boardFlag: string | undefined,
  configBoard?: string,
): Promise<{board: BoardInfo; source: BoardSource} | undefined> {
  const boards = await discoverBoards(process.cwd())
  const generics = genericBoards()

  const pick = (name: string, source: BoardSource): {board: BoardInfo; source: BoardSource} => {
    const board = boards.find((b) => b.name === name) ?? generics.find((b) => b.name === name)
    if (!board) {
      const known = [...boards, ...generics].map((b) => b.name)
      const suggestion = didYouMean(name, known)
      throw new UserError(
        `Unknown board '${name}'.` +
          (suggestion === undefined ? '' : ` Did you mean '${suggestion}'?`) +
          `\nKnown boards: ${known.join(', ')}`,
      )
    }
    return {board, source}
  }

  if (boardFlag) return pick(boardFlag, 'flag')
  if (configBoard) return pick(configBoard, 'config')
  if (boards.length === 1) return {board: boards[0]!, source: 'dependency'}
  return undefined
}

/** Hard-stop when the selected board doesn't match the connected chip.
 *  Detection failure is not an error here: a wedged device is exactly what
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
 * etc.). Mirrors the three source modes of `mikro flash`:
 *   - `buildDir`: a local ESP-IDF build
 *   - `from`: a downloaded firmware ref
 *   - neither: the prebuilt firmware bundled with this CLI version
 */
export async function resolveFlashPlan(opts: FlashPlanOptions): Promise<FlashPlan> {
  const {port, buildDir, from, board: boardFlag, configBoard, target, onProgress} = opts

  if (buildDir) {
    const [flasherArgs, esptoolPath] = await Promise.all([
      readFlasherArgs(buildDir),
      getEsptoolPath(),
    ])
    return {esptoolPath, flasherArgs}
  }

  onProgress?.('Resolving esptool…')
  const esptoolPath = await getEsptoolPath()
  let resolved = await discoverBoard(boardFlag, configBoard)

  if (resolved && target && target !== resolved.board.chip) {
    throw new UserError(
      `${resolved.board.name} is an ${resolved.board.chip} board, but --target is ${target}. ` +
        `Drop --target, or pass a board for that chip.`,
    )
  }
  // esptool refuses firmware for another chip by itself, but only after the
  // firmware is resolved (and perhaps downloaded), and with its own message.
  // Checking first costs one chip-id run and names the board that is wrong.
  if (resolved) {
    await verifyBoardChip(esptoolPath, port, resolved.board, onProgress)
  }

  let resolvedChip: Chip | undefined = target ?? resolved?.board.chip
  if (!resolvedChip) {
    onProgress?.('Detecting chip…')
    resolvedChip = await detectChip(esptoolPath, port)
  }
  // No board selected: the detected (or --target) chip's generic board.
  resolved ??= {
    board: genericBoards().find((b) => b.chip === resolvedChip) ?? {
      name: `${resolvedChip}-generic`,
      chip: resolvedChip,
      generic: true,
    },
    source: 'detected',
  }
  const boardInfo = {name: resolved.board.name, source: resolved.source}

  if (from) {
    const firmwareDir = await resolveFrom({
      from,
      chip: resolvedChip,
      board: resolved.board.name,
      onProgress: (message) => onProgress?.(message),
    })
    const flasherArgs = await readFlasherArgs(firmwareDir)
    return {esptoolPath, flasherArgs, board: boardInfo}
  }

  // Default: bundled prebuilt firmware shipped inside @mikrojs/firmware,
  // matched to this CLI's version via the lockstep release group.
  if (!hasPrebuiltFirmware(resolvedChip)) {
    throw new UserError(
      `No bundled firmware for ${resolvedChip}. ` +
        `Build a custom firmware locally and flash with --build-dir, ` +
        `or fetch a CI artifact with --from=mikrojs/mikro@<sha>.`,
    )
  }

  const flasherArgs = await readFlasherArgs(prebuiltFirmwareDir(resolvedChip))
  return {esptoolPath, flasherArgs, board: boardInfo}
}

/**
 * Resolve and flash firmware to completion, headlessly. Resolves on success,
 * rejects with the esptool failure on error. The serial port must be free
 * (no open session) before calling — esptool needs exclusive bootloader
 * access. Used by the auto-reflash flow; the interactive `mikro flash`
 * command renders its own live progress and only shares `resolveFlashPlan`.
 */
export async function flashFirmware(
  opts: FlashPlanOptions & {baudRate?: number; signal?: AbortSignal},
): Promise<void> {
  const {port, baudRate = DEFAULT_FLASH_BAUD, onProgress, signal} = opts
  const {esptoolPath, flasherArgs} = await resolveFlashPlan(opts)

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
