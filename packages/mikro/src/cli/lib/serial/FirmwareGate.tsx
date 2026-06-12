import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text, useInput} from 'ink'
import pkg from 'mikro/package.json' with {type: 'json'}
import {type ReactNode, useEffect, useState} from 'react'
import {firstValueFrom} from 'rxjs'

import {flashFirmware} from '../flashFirmware.js'
import {detectPreferredPm, installVersionCommand, mikroCommand} from '../pkgManager.js'
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
    flashFirmware({
      port: devicePath,
      onProgress: (message) => {
        if (!cancelled) setState({status: 'flashing', message})
      },
    }).then(
      () => {
        if (!cancelled) setState({status: 'flashed'})
      },
      (err: unknown) => {
        if (cancelled) return
        setState({status: 'flash_error', message: err instanceof Error ? err.message : String(err)})
      },
    )
    return () => {
      cancelled = true
    }
    // Only react to entering 'flashing'; message updates re-render in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === 'flashing', devicePath])

  // Terminal states exit the process as a side effect (not during render).
  useEffect(() => {
    if (state.status === 'flashed') process.exit(0)
    if (state.status === 'flash_error') process.exit(1)
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
      <Text>
        <Spinner spinner={spinners.dots} /> {state.message}
      </Text>
    )
  }

  if (state.status === 'flashed') {
    return <FlashedNotice command={command} />
  }

  if (state.status === 'flash_error') {
    return (
      <Text color="red">
        {figures.cross} Flashing failed: {state.message}
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
  const [pm, setPm] = useState<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm')
  useEffect(() => {
    detectPreferredPm().then(setPm, () => {})
  }, [])

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'q')) {
      process.exit(0)
    }
    const ch = input.toLowerCase()
    if (ch === 'y') {
      onConfirm({status: 'flashing', message: 'Preparing firmware…'})
    } else if (ch === 'n' || key.return) {
      onConfirm({status: 'ok', compat: 'best-effort'})
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
      <Text>
        Flash CLI-matched firmware now? <Text bold>(y/N)</Text>
      </Text>
      <Text color="gray">
        {figures.pointerSmall} Choosing no continues anyway; commands may fail against mismatched
        firmware.
      </Text>
      <Text color="gray">
        {figures.pointerSmall} Or keep the device as-is and install a matching CLI:{' '}
        {deviceVersion
          ? installVersionCommand(pm, 'mikro', deviceVersion)
          : mikroCommand(pm, 'flash')}
      </Text>
    </Box>
  )
}

function FlashedNotice(props: {command: 'dev' | 'deploy' | 'console'}) {
  const [pm, setPm] = useState<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm')
  useEffect(() => {
    detectPreferredPm().then(setPm, () => {})
  }, [])
  return (
    <Box flexDirection="column">
      <Text color="green">{figures.tick} Firmware updated.</Text>
      <Text>
        {figures.pointerSmall} Re-run <Text bold>{mikroCommand(pm, props.command)}</Text>
      </Text>
    </Box>
  )
}
