import type {InferValue} from '@optique/core/parser'
import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'
import React, {useEffect, useMemo, useState} from 'react'
import {defer, EMPTY, firstValueFrom, type Observable, of} from 'rxjs'
import {catchError, map, startWith} from 'rxjs/operators'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import type {BoardInfo} from '../lib/boards.js'
import {customFirmwareOf, type DeviceBoard, genericBoardOf} from '../lib/bundledFirmware.js'
import {formatDeviceList} from '../lib/deviceLabel.js'
import {describeError} from '../lib/errorMessage.js'
import {type FlasherArgs, getWriteFlashMultiArgs} from '../lib/esptool.js'
import {AbortQuestion, ExitKeys, useConfirmAbort, useExitKeys} from '../lib/exitKeys.js'
import {
  assertFilesystemKept,
  type BoardSource,
  type FlashPlan,
  type ImageChoice,
  parseFeatures,
  resolveFlashPlan,
} from '../lib/flashFirmware.js'
import {formatSize} from '../lib/formatSize.js'
import {plainKey} from '../lib/keys.js'
import {loadMikroConfig} from '../lib/loadMikroConfig.js'
import {INITIAL_SPAWN_STATE, ospawn, spawnErrorMessage, type SpawnState} from '../lib/ospawn.js'
import {detectPreferredPm, mikroCommand, type PkgManager} from '../lib/pkgManager.js'
import {type PostFlashResult, runPostFlash} from '../lib/postFlash.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {openSession} from '../lib/serial/openSession.js'
import {Spinner} from '../lib/Spinner.js'
import {TroubleshootingHint} from '../lib/troubleshooting.js'
import {useObservable} from '../lib/useObservable.js'
import type {args} from './flash.args.js'

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
      chosenImage?: FlashPlan['chosenImage']
      warnings: string[]
      filesystemSize?: number
    }
  | {status: 'error'; error: Error}

const BOARD_SOURCE_LABELS: Record<BoardSource, string> = {
  detected: 'default: detected chip',
  flag: 'from --board',
  config: 'from mikro.config.ts',
  device: 'kept: the board the device reports',
  dependency: 'auto: only board dependency',
  chip: "auto: only board for the device's chip",
  picked: 'picked',
}

/** Probe handshake budget, mirroring FirmwareGate: a healthy device replies
 *  to CMD_HELLO almost immediately. On timeout the flash proceeds — silent,
 *  wedged, or unflashed devices are a primary use of `mikro flash`. */
const PROBE_TIMEOUT_MS = 4000

/** The device's firmware identity (`fw`), the same when it is not the
 *  firmware bundled with this CLI (`custom`), the features it reports, and
 *  `firmware`: that identity with its version. */
type ProbeState =
  | {status: 'pending'}
  | {
      status: 'done'
      fw?: string
      custom?: string
      features?: string[]
      board?: DeviceBoard
      firmware?: {name: string; version: string}
    }

const IMAGE_SOURCE_LABELS: Record<ImageChoice['source'], string> = {
  features: 'from --features',
  device: 'what the device runs now',
}

export default function FlashCmd(props: Props) {
  const {
    args: {buildDir, from, board: boardFlag, features, chip, port, baud, yes, force},
  } = props

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
          setProbe({
            status: 'done',
            fw: ready.fw,
            custom: customFirmwareOf(ready),
            features: ready.features,
            board: genericBoardOf(ready),
            firmware:
              ready.fw !== undefined && ready.version !== null
                ? {name: ready.fw, version: ready.version}
                : undefined,
          })
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

  // What the device reports running, so the plan keeps its image and board,
  // and writes only what changes when that is the image it flashes
  const deviceFeatures = probe.status === 'done' ? probe.features : undefined
  const deviceBoard = probe.status === 'done' ? probe.board : undefined
  const deviceFirmware = probe.status === 'done' ? probe.firmware : undefined

  useEffect(() => {
    if (mutuallyExclusive) return
    if (deviceDiscovery.status === 'loading') return
    if (!devicePath) return
    // The probe first: the plan may reset the device (chip detection).
    if (probe.status === 'pending') return

    async function init() {
      // The config board only fills in without --board, --build-dir or --from,
      // so those flags keep `mikro flash` working when the config does not
      // load. A project without a config is fine.
      const config = boardFlag || buildDir || from ? null : await loadMikroConfig(process.cwd())
      const plan = await resolveFlashPlan({
        port: devicePath!,
        buildDir,
        from,
        board: boardFlag ?? pickedBoard,
        boardSource: boardFlag ? 'flag' : 'picked',
        configBoard: config?.board,
        features: features === undefined ? undefined : parseFeatures(features),
        deviceFeatures,
        deviceBoard,
        deviceFirmware,
        chip,
        // Only an interactive run without --yes can answer the picker.
        pickBoard: process.stdin.isTTY && yes !== true,
        onProgress: (message) => setInitState({status: 'loading', message}),
      })
      // Several installed boards for the device's chip: the plan only returns
      // a choice when a picker can answer it; headless runs get the list.
      if ('choose' in plan) {
        setInitState({status: 'choose', boards: plan.choose})
        return
      }
      if (force !== true) {
        setInitState({status: 'loading', message: 'Checking the app filesystem…'})
        await assertFilesystemKept(plan, devicePath!)
      }
      setInitState({status: 'ready', ...plan})
    }

    init().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      setInitState({status: 'error', error})
    })
  }, [
    mutuallyExclusive,
    buildDir,
    from,
    boardFlag,
    pickedBoard,
    features,
    chip,
    yes,
    force,
    deviceDiscovery.status,
    devicePath,
    probe.status,
    deviceFeatures,
    deviceBoard,
    deviceFirmware,
  ])

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
          {figures.cross} {describeError(initState.error)}
        </Text>
      </RenderAndExit>
    )
  }

  if (deviceDiscovery.status === 'loading') {
    return (
      <Text>
        <ExitKeys />
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
        <ExitKeys />
        <Spinner spinner={spinners.dots} /> Checking device firmware…
      </Text>
    )
  }

  if (initState.status === 'loading') {
    return (
      <Text>
        <ExitKeys />
        <Spinner spinner={spinners.dots} /> {initState.message}
      </Text>
    )
  }

  if (initState.status === 'choose') {
    return (
      <Box flexDirection="column">
        <ExitKeys />
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
  // the chip, custom firmware, a shrinking filesystem), so they finish before
  // the prompt: asking for a go-ahead and then refusing reads as the
  // confirmation having failed.
  const {board} = initState
  const replaces =
    initState.image === 'board' &&
    probe.status === 'done' &&
    probe.custom !== undefined &&
    probe.fw !== (board?.firmware ?? board?.name)
      ? [`The device runs other firmware ("${probe.fw}"), which this replaces with ${board?.name}.`]
      : []
  // Also for the generic firmware: the device's board name goes with it
  const renames =
    probe.status === 'done' && probe.board !== undefined && probe.board.name !== board?.name
      ? [
          `The device runs ${probe.board.firmware} as ${probe.board.name}, which this replaces with ${board?.name}.`,
        ]
      : []
  const warnings = [...replaces, ...renames, ...initState.warnings]

  if (!confirmed) {
    return (
      <ConfirmFlash
        port={device.path}
        flashSize={initState.flasherArgs.flashSize}
        filesystemSize={initState.filesystemSize}
        chosenImage={initState.chosenImage}
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
      chosenImage={initState.chosenImage}
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
  flashSize: string
  filesystemSize: number | undefined
  chosenImage?: FlashPlan['chosenImage']
  warnings: string[]
  onConfirm: () => void
  onCancel: () => void
}) {
  const {port, flashSize, filesystemSize, chosenImage, warnings, onConfirm, onCancel} = props

  useInput((input, key) => {
    if (plainKey(input, key).toLowerCase() === 'y') {
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
      {chosenImage ? (
        <Text>
          Image: {chosenImage.name} ({IMAGE_SOURCE_LABELS[chosenImage.source]})
        </Text>
      ) : null}
      {filesystemSize === undefined ? null : (
        <Text>
          App filesystem: {formatSize(filesystemSize)} ({flashSize} flash)
        </Text>
      )}
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
  chosenImage?: FlashPlan['chosenImage']
  /** Empty when the prompt already showed them. */
  warnings: string[]
}) {
  const {esptoolPath, flasherArgs, port, baudRate, board, chosenImage, warnings} = props
  const abort = useMemo(() => new AbortController(), [])

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

    return ospawn(esptoolPath, esptoolArgs, {signal: abort.signal})
  }, [esptoolPath, flasherArgs, port, baudRate, abort])

  const progress = useObservable(observable, INITIAL_SPAWN_STATE)
  const {output, error, completed} = progress

  // An exit key while esptool writes asks first, then stops it and exits
  const [aborted, setAborted] = useState(false)
  const confirmAbort = useConfirmAbort(!completed && !aborted, () => {
    abort.abort()
    setAborted(true)
  })
  useEffect(() => {
    if (aborted) process.exit(130)
  }, [aborted])

  const [pm, setPm] = useState<PkgManager>('npm')
  useEffect(() => {
    detectPreferredPm().then(setPm, () => {})
  }, [])

  const success = completed && !error && !aborted
  const devCommand = mikroCommand(pm, 'dev')
  const consoleCommand = mikroCommand(pm, 'console')

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
  useExitKeys(postFlash.status === 'running')
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
          {board.firmware !== undefined ? (
            <Text color="gray">firmware: {board.firmware}, with the board&apos;s name</Text>
          ) : null}
          {chosenImage ? (
            <Text color="gray">
              image: {chosenImage.name} ({IMAGE_SOURCE_LABELS[chosenImage.source]})
            </Text>
          ) : null}
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
      {aborted ? (
        <Text color="yellow">{figures.warning} Flashing aborted.</Text>
      ) : confirmAbort && !completed ? (
        <AbortQuestion during="flash" />
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
          <Text>Next, in the project:</Text>
          <Text>
            <Text color="gray">{figures.pointerSmall}</Text>{' '}
            <Text bold>{devCommand.padEnd(consoleCommand.length)}</Text> runs the app and redeploys
            it on every save
          </Text>
          <Text>
            <Text color="gray">{figures.pointerSmall}</Text> <Text bold>{consoleCommand}</Text>{' '}
            opens a prompt for running JavaScript on the device
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
