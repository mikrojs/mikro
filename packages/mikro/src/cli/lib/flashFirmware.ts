import {getEsptoolPath} from '@mikrojs/esptool'
import {hasPrebuiltFirmware, prebuiltFirmwareDir} from '@mikrojs/firmware'
import {lastValueFrom} from 'rxjs'

import {type BoardInfo, discoverBoards} from './boards.js'
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
  /** Target chip; auto-detected via esptool if omitted. */
  target?: Chip
  /** Progress callback for the resolution/flash phases. */
  onProgress?: (message: string) => void
}

export interface FlashPlan {
  esptoolPath: string
  flasherArgs: FlasherArgs
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

  throw new Error(
    `Could not detect chip type. Use --target to specify the chip (e.g. --target esp32c6).`,
  )
}

/** Resolve a board package from project dependencies, honoring an explicit
 *  `--board` flag. Returns undefined when no flag is given and the project
 *  has zero or several boards (the caller falls back to chip detection). */
export async function discoverBoard(boardFlag: string | undefined): Promise<BoardInfo | undefined> {
  const boards = await discoverBoards(process.cwd())
  if (boardFlag) {
    const board = boards.find((b) => b.name === boardFlag)
    if (!board) {
      throw new Error(
        `Board '${boardFlag}' not found in project dependencies.\n` +
          (boards.length > 0
            ? `Available boards: ${boards.map((b) => b.name).join(', ')}`
            : `No board packages found. Add a board package to your dependencies.`),
      )
    }
    return board
  }
  // Auto-discover if exactly one board
  return boards.length === 1 ? boards[0] : undefined
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
  const {port, buildDir, from, board: boardFlag, target, onProgress} = opts

  if (buildDir) {
    const [flasherArgs, esptoolPath] = await Promise.all([
      readFlasherArgs(buildDir),
      getEsptoolPath(),
    ])
    return {esptoolPath, flasherArgs}
  }

  onProgress?.('Resolving esptool…')
  const esptoolPath = await getEsptoolPath()
  const board = await discoverBoard(boardFlag)

  if (from) {
    let resolvedChip: Chip | undefined = target ?? board?.chip
    if (!resolvedChip) {
      onProgress?.('Detecting chip…')
      resolvedChip = await detectChip(esptoolPath, port)
    }
    const firmwareDir = await resolveFrom({
      from,
      chip: resolvedChip,
      board: board?.name,
      onProgress: (message) => onProgress?.(message),
    })
    const flasherArgs = await readFlasherArgs(firmwareDir)
    return {esptoolPath, flasherArgs}
  }

  // Default: bundled prebuilt firmware shipped inside @mikrojs/firmware,
  // matched to this CLI's version via the lockstep release group.
  let resolvedChip: Chip
  if (target) {
    resolvedChip = target
  } else if (board) {
    resolvedChip = board.chip
  } else {
    onProgress?.('Detecting chip…')
    resolvedChip = await detectChip(esptoolPath, port)
  }

  if (!hasPrebuiltFirmware(resolvedChip)) {
    throw new Error(
      `No bundled firmware for ${resolvedChip}. ` +
        `Build a custom firmware locally and flash with --build-dir, ` +
        `or fetch a CI artifact with --from=mikrojs/mikro@<sha>.`,
    )
  }

  const flasherArgs = await readFlasherArgs(prebuiltFirmwareDir(resolvedChip))
  return {esptoolPath, flasherArgs}
}

/**
 * Resolve and flash firmware to completion, headlessly. Resolves on success,
 * rejects with the esptool failure on error. The serial port must be free
 * (no open session) before calling — esptool needs exclusive bootloader
 * access. Used by the auto-reflash flow; the interactive `mikro flash`
 * command renders its own live progress and only shares `resolveFlashPlan`.
 */
export async function flashFirmware(opts: FlashPlanOptions & {baudRate?: number}): Promise<void> {
  const {port, baudRate = DEFAULT_FLASH_BAUD, onProgress} = opts
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

  const final = await lastValueFrom(ospawn(esptoolPath, esptoolArgs))
  if (final.error) throw final.error
}
