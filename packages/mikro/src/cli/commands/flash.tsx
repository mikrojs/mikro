import {command, constant, message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'
import React, {useEffect, useMemo, useState} from 'react'
import {defer, EMPTY, firstValueFrom, type Observable, of} from 'rxjs'
import {catchError, map, startWith} from 'rxjs/operators'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import type {BoardInfo} from '../lib/boards.js'
import {customFirmwareOf} from '../lib/bundledFirmware.js'
import {formatDeviceList} from '../lib/deviceLabel.js'
import {type FlasherArgs, getWriteFlashMultiArgs} from '../lib/esptool.js'
import {type BoardSource, type FlashPlan, resolveFlashPlan} from '../lib/flashFirmware.js'
import {loadMikroConfig} from '../lib/loadMikroConfig.js'
import {INITIAL_SPAWN_STATE, ospawn, spawnErrorMessage, type SpawnState} from '../lib/ospawn.js'
import {detectPreferredPm, mikroCommand, type PkgManager} from '../lib/pkgManager.js'
import {port} from '../lib/portValueParser.js'
import {type PostFlashResult, runPostFlash} from '../lib/postFlash.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {openSession} from '../lib/serial/openSession.js'
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
        description: message`Board name, for example @acme/devboard or esp32c6-generic. Discovered from package.json if omitted.`,
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
    force: optional(
      flag('--force', {
        description: message`Flash the bundled firmware even if the device reports custom firmware`,
      }),
    ),
  }),
)

type Props = {
  args: InferValue<typeof args>
}

type InitState =
  | {status: 'loading'; message: string}
  | {status: 'choose'; boards: BoardInfo[]}
  | {
      status: 'ready'
      flasherArgs: FlasherArgs
      esptoolPath: string
      image: FlashPlan['image']
      board?: FlashPlan['board']
      warnings: string[]
    }
  | {status: 'error'; error: Error}

const BOARD_SOURCE_LABELS: Record<BoardSource, string> = {
  detected: 'default: detected chip',
  flag: 'from --board',
  config: 'from mikro.config.ts',
  dependency: 'auto: only board dependency',
  chip: "auto: only board for the device's chip",
  picked: 'picked',
}

/** Probe handshake budget, mirroring FirmwareGate: a healthy device replies
 *  to CMD_HELLO almost immediately. On timeout the flash proceeds — silent,
 *  wedged, or unflashed devices are a primary use of `mikro flash`. */
const PROBE_TIMEOUT_MS = 4000

/** The device's firmware identity (`fw`), and the same when it is not the
 *  firmware bundled with this CLI (`custom`). */
type ProbeState = {status: 'pending'} | {status: 'done'; fw?: string; custom?: string}

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
      force,
    },
  } = props

  const deprecatedFlag = release ? '--release' : firmwareSource ? '--firmware' : undefined
  const mutuallyExclusive = buildDir && from
  const baudRate = baud ? Number(baud) : 460800
  const deviceDiscovery = useDevices()
  const [confirmed, setConfirmed] = useState(yes === true)
  // A board chosen in the picker when several board packages are installed
  // and neither --board nor mikro.config.ts decides.
  const [pickedBoard, setPickedBoard] = useState<string | undefined>(undefined)
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

  // The device's firmware identity, read before the plan: its chip detection
  // resets the device. Flashing the bundled image over custom firmware
  // silently reverts its sdkconfig and drops its native modules, so that is
  // refused unless --force; a board's image over other firmware gets a warning
  // at the prompt. --build-dir and --from are explicit choices and skip it.
  const needsProbe = !buildDir && !from && force !== true
  const [probe, setProbe] = useState<ProbeState>(
    needsProbe ? {status: 'pending'} : {status: 'done'},
  )

  useEffect(() => {
    if (!needsProbe || !devicePath) return
    let cancelled = false
    const handles = openSession({port: devicePath, compat: 'report'})
    handles
      .then(async (h) => {
        try {
          const ready = await firstValueFrom(h.session.awaitReady$(PROBE_TIMEOUT_MS))
          if (cancelled) return
          setProbe({status: 'done', fw: ready.fw, custom: customFirmwareOf(ready)})
        } finally {
          h.close()
        }
      })
      .catch(() => {
        // Timeout / disconnect / no reply: proceed. A device too broken to
        // identify itself is exactly what `mikro flash` recovers.
        if (!cancelled) setProbe({status: 'done'})
      })
    return () => {
      cancelled = true
      handles.then((h) => h.close()).catch(() => {})
    }
  }, [needsProbe, devicePath])

  useEffect(() => {
    if (deprecatedFlag) return
    if (mutuallyExclusive) return
    if (deviceDiscovery.status === 'loading') return
    if (!devicePath) return
    // The probe first: the plan may reset the device (chip detection).
    if (probe.status === 'pending') return

    async function init() {
      // The config board only fills in without --board or --build-dir, so
      // those flags keep `mikro flash` working when the config does not load.
      // A project without a config is fine.
      const config = boardFlag || buildDir ? null : await loadMikroConfig(process.cwd())
      const plan = await resolveFlashPlan({
        port: devicePath!,
        buildDir,
        from,
        board: boardFlag ?? pickedBoard,
        boardSource: boardFlag ? 'flag' : 'picked',
        configBoard: config?.board,
        target,
        // Only an interactive run without --yes can answer the picker.
        pickBoard: process.stdin.isTTY && yes !== true,
        onProgress: (message) => setInitState({status: 'loading', message}),
      })
      // Several installed boards for the device's chip: the plan only returns
      // a choice when a picker can answer it; headless runs get the list.
      if ('choose' in plan) setInitState({status: 'choose', boards: plan.choose})
      else setInitState({status: 'ready', ...plan})
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
    pickedBoard,
    target,
    yes,
    deviceDiscovery.status,
    devicePath,
    probe.status,
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
            {formatDeviceList(devices).map((line, i) => (
              <Text key={devices[i]!.path}>{line}</Text>
            ))}
          </Box>
        ) : (
          <Text>No devices found</Text>
        )}
        <TroubleshootingHint />
      </RenderAndExit>
    )
  }

  const refused =
    initState.status === 'ready' && initState.image === 'bundled' && probe.status === 'done'
      ? probe.custom
      : undefined
  if (refused !== undefined) {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">
          {figures.cross} Device is running custom firmware (&quot;{refused}&quot;). Flashing the
          firmware bundled with this CLI would revert its sdkconfig and drop its native modules.
        </Text>
        <Text>
          Re-run with <Text bold>--force</Text> to overwrite it, or flash your own build with{' '}
          <Text bold>--build-dir</Text>.
        </Text>
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
        {formatDeviceList(devices).map((line, i) => (
          <Text key={devices[i]!.path}>{line}</Text>
        ))}
      </RenderAndExit>
    )
  }

  if (probe.status === 'pending') {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> Checking device firmware…
      </Text>
    )
  }

  if (initState.status === 'loading') {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> {initState.message}
      </Text>
    )
  }

  if (initState.status === 'choose') {
    return (
      <Box flexDirection="column">
        <Text>Several board packages are installed. Flash firmware for:</Text>
        <SelectInput
          items={initState.boards.map((b) => ({
            label: `${b.name} (${b.chip})${b.description ? `  ${b.description}` : ''}`,
            value: b.name,
          }))}
          onSelect={(item) => {
            setInitState({status: 'loading', message: 'Preparing firmware…'})
            setPickedBoard(item.value)
          }}
        />
      </Box>
    )
  }

  // The flash plan and the probe can both refuse the flash (no firmware for
  // the chip, custom firmware), so they finish before the prompt: asking for
  // a go-ahead and then refusing reads as the confirmation having failed.
  const {board} = initState
  const replaces =
    initState.image === 'board' &&
    probe.status === 'done' &&
    probe.custom !== undefined &&
    probe.fw !== board?.name
      ? [`The device runs other firmware ("${probe.fw}"), which this replaces with ${board?.name}.`]
      : []
  const warnings = [...replaces, ...initState.warnings]

  if (!confirmed) {
    return (
      <ConfirmFlash
        port={device.path}
        warnings={warnings}
        onConfirm={() => setConfirmed(true)}
        onCancel={() => process.exit(0)}
      />
    )
  }

  const {flasherArgs, esptoolPath} = initState

  return (
    <FlashProgress
      esptoolPath={esptoolPath}
      flasherArgs={flasherArgs}
      port={device.path}
      baudRate={baudRate}
      board={board}
      // Warnings were shown at the prompt, unless --yes skipped it.
      warnings={yes === true ? warnings : []}
    />
  )
}

/** What the plan and the probe noticed: shown before the go-ahead. */
function Warnings(props: {warnings: string[]}) {
  return (
    <>
      {props.warnings.map((warning) => (
        <Text key={warning} color="yellow">
          {figures.warning} {warning}
        </Text>
      ))}
    </>
  )
}

function ConfirmFlash(props: {
  port: string
  warnings: string[]
  onConfirm: () => void
  onCancel: () => void
}) {
  const {port, warnings, onConfirm, onCancel} = props

  useInput((input) => {
    if (input.toLowerCase() === 'y') {
      onConfirm()
    } else {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column">
      <Warnings warnings={warnings} />
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

type PostFlashState =
  | {status: 'idle'}
  | {status: 'running'}
  | {status: 'done'; result: PostFlashResult}
  | {status: 'failed'; message: string}

function FlashProgress(props: {
  esptoolPath: string
  flasherArgs: FlasherArgs
  port: string
  baudRate: number
  board?: FlashPlan['board']
  /** Empty when the prompt already showed them. */
  warnings: string[]
}) {
  const {esptoolPath, flasherArgs, port, baudRate, board, warnings} = props

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

  // Reconnect once the device reboots to prove the image runs, and seed a name
  // while we're the one provisioning it. Best-effort: the flash has already
  // succeeded, so a failure here is a warning and never changes the exit code.
  // `defer` so the connect starts on subscribe, not during render.
  const postFlashObservable = useMemo(
    (): Observable<PostFlashState> =>
      success
        ? defer(() => runPostFlash(port)).pipe(
            map((result): PostFlashState => ({status: 'done', result})),
            catchError((err: unknown) =>
              of<PostFlashState>({
                status: 'failed',
                message: err instanceof Error ? err.message : String(err),
              }),
            ),
            startWith<PostFlashState>({status: 'running'}),
          )
        : EMPTY,
    [success, port],
  )
  const postFlash = useObservable(postFlashObservable, {status: 'idle'} as PostFlashState)
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
      {board ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="gray">
            board: {board.name} ({BOARD_SOURCE_LABELS[board.source]})
          </Text>
          {board.source === 'picked' ? (
            <Text color="gray">
              add board: &apos;{board.name}&apos; to mikro.config.ts, or pass --board, to skip the
              prompt
            </Text>
          ) : null}
          <Warnings warnings={warnings} />
        </Box>
      ) : null}
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
          <Text color="red">{spawnErrorMessage(error, 'esptool')}</Text>
        </Box>
      ) : null}
      {success && postFlash.status !== 'idle' ? (
        <Text>
          {postFlash.status === 'running' ? (
            <Spinner spinner={spinners.dots} />
          ) : postFlash.status === 'done' ? (
            <Text color="green">{figures.tick}</Text>
          ) : (
            <Text color="yellow">{figures.warning}</Text>
          )}{' '}
          {postFlash.status === 'running'
            ? 'Waiting for the device to boot…'
            : postFlash.status === 'done'
              ? `Booted ${postFlash.result.name ?? 'device'}${
                  postFlash.result.firmware ? ` (firmware ${postFlash.result.firmware})` : ''
                }${postFlash.result.seeded ? ' · named this device' : ''}`
              : `Flashed, but the device did not respond: ${postFlash.message}`}
        </Text>
      ) : null}
      {postFlash.status === 'done' && postFlash.result.nameUnreadable ? (
        <Text color="yellow">
          {'  '}
          {figures.warning} This device has a stored name that could not be read, so it was left
          alone. Set one with <Text bold>mikro name set &lt;name&gt;</Text>.
        </Text>
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
