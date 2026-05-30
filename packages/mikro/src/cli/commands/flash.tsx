import {getEsptoolPath} from '@mikrojs/esptool'
import {hasPrebuiltFirmware, prebuiltFirmwareDir} from '@mikrojs/firmware'
import {command, constant, message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text, useInput} from 'ink'
import React, {useEffect, useMemo, useState} from 'react'
import type {Observable} from 'rxjs'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import {type BoardInfo, discoverBoards} from '../lib/boards.js'
import {type FlasherArgs, getWriteFlashMultiArgs, readFlasherArgs} from '../lib/esptool.js'
import {type Chip, resolveFrom} from '../lib/firmware.js'
import {INITIAL_SPAWN_STATE, ospawn, type SpawnState} from '../lib/ospawn.js'
import {detectPreferredPm, mikroCommand, type PkgManager} from '../lib/pkgManager.js'
import {port} from '../lib/portValueParser.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {Spinner} from '../lib/Spinner.js'
import {TroubleshootingHint} from '../lib/troubleshooting.js'
import {useObservable} from '../lib/useObservable.js'

export const args = command(
  'flash',
  object({
    action: constant('flash'),
    buildDir: optional(
      option('--build-dir', string({metavar: 'DIR'}), {
        description: message`Path to a local ESP-IDF build directory. If omitted, downloads pre-built firmware.`,
      }),
    ),
    from: optional(
      option('--from', string({metavar: 'REF'}), {
        description: message`Firmware source: a release tag (v0.2.0), branch, commit SHA, GitHub repo (user/repo or user/repo@ref), or URL to a .tar.gz archive.`,
      }),
    ),
    release: optional(
      option('--release', string({metavar: 'REF'}), {
        description: message`Deprecated. Use --from instead.`,
      }),
    ),
    firmware: optional(
      option('--firmware', string({metavar: 'SOURCE'}), {
        description: message`Deprecated. Use --from instead.`,
      }),
    ),
    board: optional(
      option('--board', string({metavar: 'BOARD'}), {
        description: message`Board name (e.g. xiao-esp32c6). Discovered from package.json if omitted.`,
      }),
    ),
    target: optional(
      option('--target', string({metavar: 'CHIP'}), {
        description: message`Target chip (e.g. esp32c6). Auto-detected from the connected device if omitted.`,
      }),
    ),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device to flash to. Auto-detected if omitted.`,
      }),
    ),
    baud: optional(
      option('--baud', string({metavar: 'BAUD'}), {
        description: message`Baud rate for flashing (default: 460800)`,
      }),
    ),
    yes: optional(
      flag('-y', '--yes', {
        description: message`Skip confirmation prompt`,
      }),
    ),
  }),
)

type Props = {
  args: InferValue<typeof args>
}

type InitState =
  | {status: 'loading'; message: string}
  | {status: 'ready'; flasherArgs: FlasherArgs; esptoolPath: string}
  | {status: 'error'; error: Error}

async function resolveEsptool(): Promise<string> {
  return await getEsptoolPath()
}

async function detectChip(esptoolPath: string, port: string): Promise<Chip> {
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

async function discoverBoard(boardFlag: string | undefined): Promise<BoardInfo | undefined> {
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

export default function FlashCmd(props: Props) {
  const {
    args: {
      buildDir,
      from,
      release,
      firmware: firmwareSource,
      board: boardFlag,
      target,
      port,
      baud,
      yes,
    },
  } = props

  const deprecatedFlag = release ? '--release' : firmwareSource ? '--firmware' : undefined
  const mutuallyExclusive = buildDir && from
  const baudRate = baud ? Number(baud) : 460800
  const deviceDiscovery = useDevices()
  const [confirmed, setConfirmed] = useState(yes === true)
  const [initState, setInitState] = useState<InitState>({
    status: 'loading',
    message: buildDir ? 'Reading build configuration…' : 'Preparing firmware…',
  })

  const devices = deviceDiscovery.status === 'success' ? deviceDiscovery.value : ([] as PortInfo[])

  const device = port
    ? devices.find((dev) => dev.path === port)
    : devices.length === 1
      ? devices[0]
      : undefined

  const devicePath = device?.path

  useEffect(() => {
    if (deprecatedFlag) return
    if (mutuallyExclusive) return
    if (deviceDiscovery.status === 'loading') return
    if (!devicePath) return

    async function init() {
      if (buildDir) {
        // Local build mode
        const [flasherArgs, esptoolPath] = await Promise.all([
          readFlasherArgs(buildDir),
          resolveEsptool(),
        ])
        setInitState({status: 'ready', flasherArgs, esptoolPath})
      } else if (from) {
        // --from: unified firmware source resolution
        setInitState({status: 'loading', message: 'Resolving esptool…'})
        const esptoolPath = await resolveEsptool()

        // Discover board for artifact selection
        const board = await discoverBoard(boardFlag)
        let resolvedChip: Chip | undefined = target ?? board?.chip
        if (!resolvedChip) {
          setInitState({status: 'loading', message: 'Detecting chip…'})
          resolvedChip = await detectChip(esptoolPath, devicePath!)
        }

        const firmwareDir = await resolveFrom({
          from,
          chip: resolvedChip,
          board: board?.name,
          onProgress: (message) => setInitState({status: 'loading', message}),
        })
        const flasherArgs = await readFlasherArgs(firmwareDir)
        setInitState({status: 'ready', flasherArgs, esptoolPath})
      } else {
        // Default: bundled prebuilt firmware shipped inside @mikrojs/firmware,
        // matched to this CLI's version via the lockstep release group.
        setInitState({status: 'loading', message: 'Resolving esptool…'})
        const esptoolPath = await resolveEsptool()

        const board = await discoverBoard(boardFlag)

        let resolvedChip: Chip
        if (target) {
          resolvedChip = target
        } else if (board) {
          resolvedChip = board.chip
        } else {
          setInitState({status: 'loading', message: 'Detecting chip…'})
          resolvedChip = await detectChip(esptoolPath, devicePath!)
        }

        if (!hasPrebuiltFirmware(resolvedChip)) {
          throw new Error(
            `No bundled firmware for ${resolvedChip}. ` +
              `Build a custom firmware locally and flash with --build-dir, ` +
              `or fetch a CI artifact with --from=mikrojs/mikro@<sha>.`,
          )
        }

        const flasherArgs = await readFlasherArgs(prebuiltFirmwareDir(resolvedChip))
        setInitState({status: 'ready', flasherArgs, esptoolPath})
      }
    }

    init().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      setInitState({status: 'error', error})
    })
  }, [
    mutuallyExclusive,
    deprecatedFlag,
    buildDir,
    from,
    boardFlag,
    target,
    deviceDiscovery.status,
    devicePath,
  ])

  if (deprecatedFlag) {
    const value = release ?? firmwareSource
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">
          {figures.cross} {deprecatedFlag} has been removed. Use --from instead:
        </Text>
        <Text>
          {'\n'} mikro flash --from {value}
        </Text>
      </RenderAndExit>
    )
  }

  if (mutuallyExclusive) {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">{figures.cross} --build-dir and --from are mutually exclusive.</Text>
      </RenderAndExit>
    )
  }

  if (initState.status === 'error') {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">
          {figures.cross} {initState.error.message}
        </Text>
      </RenderAndExit>
    )
  }

  if (deviceDiscovery.status === 'loading') {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> Detecting devices…
      </Text>
    )
  }

  if (port && deviceDiscovery.status === 'success' && !device) {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">
          {figures.cross} Device not found: {port}
        </Text>
        {devices.length > 0 ? (
          <Box paddingTop={1} flexDirection="column">
            <Text>Connected devices:</Text>
            {devices.map((d, i) => (
              <Text key={d.path}>
                {i + 1}. {d.path} ({d.manufacturer} {d.serialNumber})
              </Text>
            ))}
          </Box>
        ) : (
          <Text>No devices found</Text>
        )}
        <TroubleshootingHint />
      </RenderAndExit>
    )
  }

  if (!device) {
    if (devices.length === 0) {
      return (
        <RenderAndExit exitCode={1}>
          <Text color="red">{figures.cross} No devices found. Connect a device and try again.</Text>
          <TroubleshootingHint />
        </RenderAndExit>
      )
    }
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">
          {figures.cross} Multiple devices found. Use --port to specify which one:
        </Text>
        {devices.map((d, i) => (
          <Text key={d.path}>
            {i + 1}. {d.path} ({d.manufacturer} {d.serialNumber})
          </Text>
        ))}
      </RenderAndExit>
    )
  }

  if (!confirmed) {
    return (
      <ConfirmFlash
        port={device.path}
        onConfirm={() => setConfirmed(true)}
        onCancel={() => process.exit(0)}
      />
    )
  }

  if (initState.status === 'loading') {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> {initState.message}
      </Text>
    )
  }

  const {flasherArgs, esptoolPath} = initState

  return (
    <FlashProgress
      esptoolPath={esptoolPath}
      flasherArgs={flasherArgs}
      port={device.path}
      baudRate={baudRate}
    />
  )
}

function ConfirmFlash(props: {port: string; onConfirm: () => void; onCancel: () => void}) {
  const {port, onConfirm, onCancel} = props

  useInput((input) => {
    if (input.toLowerCase() === 'y') {
      onConfirm()
    } else {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column">
      <Text color="yellow">
        {figures.warning} This will flash new firmware to the device on {port}, overwriting the
        existing firmware.
      </Text>
      <Text>
        {'\n'}Continue? <Text bold>(y/N)</Text>
      </Text>
    </Box>
  )
}

function FlashProgress(props: {
  esptoolPath: string
  flasherArgs: FlasherArgs
  port: string
  baudRate: number
}) {
  const {esptoolPath, flasherArgs, port, baudRate} = props

  const observable = useMemo((): Observable<SpawnState> => {
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

    return ospawn(esptoolPath, esptoolArgs)
  }, [esptoolPath, flasherArgs, port, baudRate])

  const progress = useObservable(observable, INITIAL_SPAWN_STATE)
  const {output, error, completed} = progress

  const [pm, setPm] = useState<PkgManager>('npm')
  useEffect(() => {
    detectPreferredPm().then(setPm, () => {})
  }, [])

  const success = completed && !error
  const lastLine = getLastLine(output)

  return (
    <Box flexDirection="column">
      <Text>
        {error ? (
          <Text color="red">{figures.cross}</Text>
        ) : completed ? (
          <Text color="green">{figures.tick}</Text>
        ) : (
          <Spinner spinner={spinners.dots} />
        )}{' '}
        {success ? 'Flashed' : 'Flashing'} {flasherArgs.chip} firmware via {port}
        {error ? <Text> failed</Text> : null}
      </Text>
      {!completed && lastLine ? (
        <Box paddingLeft={2}>
          <Text color="gray">{lastLine}</Text>
        </Box>
      ) : null}
      {error ? (
        <Box flexDirection="column" paddingLeft={2}>
          {output.map((chunk, i) => (
            <Text key={i} color={chunk.type === 'err' ? 'red' : 'gray'}>
              {textDecoder.decode(chunk.output)}
            </Text>
          ))}
          <Text color="red">{error.stack}</Text>
        </Box>
      ) : null}
      {success ? (
        <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
          <Text bold>Next steps</Text>
          <Text>
            <Text color="gray">{figures.pointerSmall}</Text> Start a dev session:{' '}
            <Text bold>{mikroCommand(pm, 'dev')}</Text>
          </Text>
          <Text>
            <Text color="gray">{figures.pointerSmall}</Text> Open a REPL:{' '}
            <Text bold>{mikroCommand(pm, 'console')}</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

function getLastLine(output: SpawnState['output']): string {
  for (let i = output.length - 1; i >= 0; i--) {
    const text = textDecoder.decode(output[i]!.output)
    // Split on either CR or LF so esptool's \r-overwritten progress
    // updates are treated as distinct lines, not concatenated.
    const lines = text.split(/[\r\n]+/)
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j]!.trim()
      if (line) return line
    }
  }
  return ''
}

const textDecoder = new TextDecoder()
