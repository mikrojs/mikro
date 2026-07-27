import {spawn} from 'node:child_process'

import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text, useApp, useInput} from 'ink'
import pkg from 'mikro/package.json' with {type: 'json'}
import {type ReactNode, useEffect, useRef, useState} from 'react'
import {firstValueFrom} from 'rxjs'

import {customFirmwareOf} from '../bundledFirmware.js'
import {flashFirmware} from '../flashFirmware.js'
import {detectPreferredPm, rerunCommand} from '../pkgManager.js'
import {Spinner} from '../Spinner.js'
import {openSession} from './openSession.js'

/** Probe handshake budget. A healthy device replies to CMD_HELLO almost
 *  immediately; this only bounds how long we wait before giving up on the
 *  compat probe and letting the command's own connect handle a slow or
 *  silent device. Kept well under the command's own 10s ready timeout. */
const PROBE_TIMEOUT_MS = 4000

const cliVersion = pkg.version

type GateState =
  | {status: 'probing'}
  | {status: 'ok'; compat: 'enforce' | 'best-effort'}
  | {status: 'prompt'; deviceVersion: string | null}
  | {status: 'flashing'; message: string}
  | {status: 'flashed'}
  | {status: 'flash_error'; message: string}
  | {status: 'aborted'}
  /** The device reports custom firmware; the bundled reflash is refused. */
  | {status: 'refused'; message: string}

export interface FirmwareGateProps {
  devicePath: string
  command: 'dev' | 'deploy' | 'console'
  /** Skip the y/N prompt and flash immediately on incompatibility. */
  yes?: boolean
  /** Rendered once the firmware is confirmed compatible (or undetermined).
   *  `compat` is 'best-effort' when the user declined the reflash prompt and
   *  chose to continue against mismatched firmware; pass it to the command's
   *  own session connect so it warns instead of throwing. */
  children: (compat: 'enforce' | 'best-effort') => ReactNode
}

/**
 * Gate that sits between device selection and a REPL-class command's UI.
 * It opens a short probe session to check firmware compatibility:
 *
 *   - compatible (or undetermined — slow/silent device): render `children`
 *     and let the command connect normally.
 *   - incompatible: prompt to flash CLI-matched firmware (or flash straight
 *     away with `yes`), then exit with a "re-run" hint. We deliberately do
 *     not reconnect after flashing — the device resets and its USB-CDC port
 *     re-enumerates, so a clean re-run is more robust than resuming.
 *     Declining the prompt continues anyway: children render with
 *     compat 'best-effort' so their own connect warns instead of throwing.
 *
 * The probe session is always closed before rendering children or flashing
 * so the port is free for whoever runs next.
 */
export function FirmwareGate(props: FirmwareGateProps) {
  const {devicePath, command, yes, children} = props
  const [state, setState] = useState<GateState>({status: 'probing'})
  // Ctrl+C during a flash asks for confirmation before aborting, since killing
  // esptool mid-write can leave the device unbootable. Kept out of GateState so
  // toggling it doesn't restart the flash effect.
  const [confirmAbort, setConfirmAbort] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Probe compatibility once on mount.
  useEffect(() => {
    let cancelled = false
    const handles = openSession({port: devicePath, compat: 'report'})

    handles
      .then(async (h) => {
        try {
          const ready = await firstValueFrom(h.session.awaitReady$(PROBE_TIMEOUT_MS))
          if (cancelled) return
          if (ready.advisory?.kind === 'incompatible') {
            // Never flash the bundled build over a device reporting custom
            // firmware, not even with --yes: that silently reverts its
            // sdkconfig and drops its native modules. The advisory message
            // already carries the rebuild hint.
            if (customFirmwareOf(ready) !== undefined) {
              setState({status: 'refused', message: ready.advisory.message})
              return
            }
            setState(
              yes
                ? {status: 'flashing', message: 'Preparing firmware…'}
                : {status: 'prompt', deviceVersion: ready.version},
            )
          } else {
            setState({status: 'ok', compat: 'enforce'})
          }
        } finally {
          h.close()
        }
      })
      .catch(() => {
        // Timeout / disconnect / unresolved port: don't block. Proceed and
        // let the command's own connect surface the real failure as today.
        if (!cancelled) setState({status: 'ok', compat: 'enforce'})
      })

    return () => {
      cancelled = true
      handles.then((h) => h.close()).catch(() => {})
    }
  }, [devicePath, yes])

  // Run the flash once we enter the flashing state.
  useEffect(() => {
    if (state.status !== 'flashing') return
    let cancelled = false
    const controller = new AbortController()
    abortRef.current = controller
    flashFirmware({
      port: devicePath,
      signal: controller.signal,
      onProgress: (message) => {
        if (!cancelled) setState({status: 'flashing', message})
      },
    }).then(
      () => {
        if (!cancelled) setState({status: 'flashed'})
      },
      (err: unknown) => {
        // A user-confirmed abort transitions to 'aborted' itself; ignore the
        // resulting flash rejection.
        if (cancelled || controller.signal.aborted) return
        setState({status: 'flash_error', message: err instanceof Error ? err.message : String(err)})
      },
    )
    return () => {
      cancelled = true
    }
    // Only react to entering 'flashing'; message updates re-render in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === 'flashing', devicePath])

  // Ctrl+C while flashing: confirm first (aborting mid-write is dangerous),
  // then abort esptool and exit. The flash keeps running under the prompt.
  useInput(
    (input, key) => {
      const ctrlC = key.ctrl && (input === 'c' || input === 'q')
      if (!confirmAbort) {
        if (ctrlC) setConfirmAbort(true)
        return
      }
      if (input.toLowerCase() === 'y') {
        abortRef.current?.abort()
        setState({status: 'aborted'})
      } else if (input.toLowerCase() === 'n' || key.escape) {
        setConfirmAbort(false)
      }
    },
    {isActive: state.status === 'flashing'},
  )

  // Terminal states exit the process as a side effect (not during render).
  // 'flashed' is handled by FlashedNotice: it prompts to re-run (or, with
  // `yes`, exits with a re-run hint like before).
  useEffect(() => {
    if (state.status === 'flash_error') process.exit(1)
    if (state.status === 'refused') process.exit(1)
    if (state.status === 'aborted') process.exit(130)
  }, [state.status])

  if (state.status === 'ok') return <>{children(state.compat)}</>

  if (state.status === 'probing') {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> Checking firmware on {devicePath}…
      </Text>
    )
  }

  if (state.status === 'prompt') {
    return <ReflashPrompt {...state} command={command} onConfirm={setState} />
  }

  if (state.status === 'flashing') {
    return (
      <Box flexDirection="column">
        <Text>
          <Spinner spinner={spinners.dots} /> {state.message}
        </Text>
        {confirmAbort && (
          <>
            <Text color="yellow">
              {figures.warning} Aborting mid-flash can leave the device unbootable and require a
              manual re-flash.
            </Text>
            <Text>
              Abort anyway? <Text bold>(y/N)</Text>
            </Text>
          </>
        )}
      </Box>
    )
  }

  if (state.status === 'aborted') {
    return <Text color="yellow">{figures.warning} Flashing aborted.</Text>
  }

  if (state.status === 'flashed') {
    return <FlashedNotice yes={yes === true} />
  }

  if (state.status === 'flash_error') {
    return (
      <Text color="red">
        {figures.cross} Flashing failed: {state.message}
      </Text>
    )
  }

  if (state.status === 'refused') {
    return (
      <Text color="yellow">
        {figures.warning} {state.message}
      </Text>
    )
  }

  return null
}

function ReflashPrompt(props: {
  deviceVersion: string | null
  command: 'dev' | 'deploy' | 'console'
  onConfirm: (state: GateState) => void
}) {
  const {deviceVersion, onConfirm} = props

  useInput((input, key) => {
    const ch = input.toLowerCase()
    if (ch === 'y') {
      onConfirm({status: 'flashing', message: 'Preparing firmware…'})
    } else if (ch === 'n') {
      onConfirm({status: 'ok', compat: 'best-effort'})
    } else if (ch === 'c' || key.return || key.escape || (key.ctrl && (ch === 'c' || ch === 'q'))) {
      // Cancel: exit without touching the device.
      process.exit(0)
    }
    // Any other key is ignored.
  })

  const got = deviceVersion ?? 'an unknown version'
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        {figures.warning} Device is running mikrojs v{got}, which is not compatible with this CLI (v
        {cliVersion}).
      </Text>
      <Box marginTop={1}>
        <Text>
          Would you like to flash firmware v{cliVersion} to the device?{' '}
          <Text bold>(y)es / (n)o / (C)ancel</Text>
        </Text>
      </Box>
    </Box>
  )
}

/** Post-flash notice. Interactively offers to re-run the original command by
 *  re-spawning this exact process invocation; with `yes` it keeps the
 *  non-prompting behavior and just exits with a re-run hint. */
function FlashedNotice(props: {yes: boolean}) {
  const [pm, setPm] = useState<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm')
  const [rerunning, setRerunning] = useState(false)
  const {exit: exitInk} = useApp()

  useEffect(() => {
    detectPreferredPm().then(setPm, () => {})
  }, [])

  // With `yes` the user asked for a non-interactive flash: print the hint
  // (first render happens before this effect) and exit as before.
  useEffect(() => {
    if (props.yes) process.exit(0)
  }, [props.yes])

  useInput(
    (input, key) => {
      if (key.ctrl && (input === 'c' || input === 'q')) process.exit(0)
      const ch = input.toLowerCase()
      if (ch === 'y' || key.return) {
        setRerunning(true)
      } else if (ch === 'n' || key.escape) {
        process.exit(0)
      }
      // Any other key is ignored.
    },
    {isActive: !props.yes && !rerunning},
  )

  // Re-spawn the exact original invocation. Ink must unmount first so raw
  // mode is restored and the child gets a clean inherited TTY; the spawn is
  // deferred a tick to run after that teardown. The parent then just waits
  // and mirrors the child's exit code. Ctrl+C is delivered to the whole
  // process group, so the parent ignores it and lets the child handle it.
  useEffect(() => {
    if (!rerunning) return
    exitInk()
    setImmediate(() => {
      process.on('SIGINT', () => {})
      process.on('SIGTERM', () => {})
      const child = spawn(process.execPath, process.argv.slice(1), {stdio: 'inherit'})
      child.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error(`${figures.cross} Failed to re-run the command`, err)
        process.exit(1)
      })
      child.on('exit', (code, signal) => {
        process.exit(signal !== null ? 1 : (code ?? 0))
      })
    })
  }, [rerunning, exitInk])

  return (
    <Box flexDirection="column">
      <Text color="green">{figures.tick} Firmware updated.</Text>
      {props.yes ? (
        <Text>
          {figures.pointerSmall} Re-run <Text bold>{rerunCommand(pm)}</Text>
        </Text>
      ) : rerunning ? (
        <Text>
          {figures.pointerSmall} Re-running <Text bold>{rerunCommand(pm)}</Text>…
        </Text>
      ) : (
        <Text>
          {figures.pointerSmall} Re-run <Text bold>{rerunCommand(pm)}</Text> now?{' '}
          <Text bold>(Y/n)</Text>
        </Text>
      )}
    </Box>
  )
}
