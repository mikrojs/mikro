import {getEsptoolPath} from '@mikrojs/esptool'
import {command, constant, message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text, useInput} from 'ink'
import {useEffect, useMemo, useState} from 'react'
import type {Observable} from 'rxjs'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import {INITIAL_SPAWN_STATE, ospawn, type SpawnState} from '../lib/ospawn.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {Spinner} from '../lib/Spinner.js'
import {TroubleshootingHint} from '../lib/troubleshooting.js'
import {useObservable} from '../lib/useObservable.js'

export const args = command(
  'erase',
  object({
    action: constant('erase'),
    port: optional(
      option('-p', '--port', string({metavar: 'PORT'}), {
        description: message`Serial port of device to erase. Auto-detected if omitted.`,
      }),
    ),
    baud: optional(
      option('--baud', string({metavar: 'BAUD'}), {
        description: message`Baud rate (default: 460800)`,
      }),
    ),
    yes: optional(
      flag('-y', '--yes', {
        description: message`Skip confirmation prompt`,
      }),
    ),
  }),
  {description: message`Erase all flash on a connected device (factory reset)`},
)

type Props = {
  args: InferValue<typeof args>
}

type InitState =
  | {status: 'loading'}
  | {status: 'ready'; esptoolPath: string}
  | {status: 'error'; error: Error}

export default function EraseCmd(props: Props) {
  const {
    args: {port, baud, yes},
  } = props
  return <DeviceErase port={port} baud={baud} yes={yes === true} />
}

function DeviceErase({port, baud, yes}: {port?: string; baud?: string; yes: boolean}) {
  const baudRate = baud ? Number(baud) : 460800
  const deviceDiscovery = useDevices()
  const [initState, setInitState] = useState<InitState>({status: 'loading'})
  const [confirmed, setConfirmed] = useState(yes)

  useEffect(() => {
    getEsptoolPath().then(
      (esptoolPath) => setInitState({status: 'ready', esptoolPath}),
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        setInitState({status: 'error', error})
      },
    )
  }, [])

  if (initState.status === 'error') {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">
          {figures.cross} {initState.error.message}
        </Text>
      </RenderAndExit>
    )
  }

  if (initState.status === 'loading' || deviceDiscovery.status === 'loading') {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> Preparing…
      </Text>
    )
  }

  const devices = deviceDiscovery.status === 'success' ? deviceDiscovery.value : ([] as PortInfo[])

  const device = port
    ? devices.find((dev) => dev.path === port)
    : devices.length === 1
      ? devices[0]
      : undefined

  if (port && !device) {
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
      <ConfirmErase
        port={device.path}
        onConfirm={() => setConfirmed(true)}
        onCancel={() => process.exit(0)}
      />
    )
  }

  return (
    <EraseProgress esptoolPath={initState.esptoolPath} port={device.path} baudRate={baudRate} />
  )
}

function ConfirmErase(props: {port: string; onConfirm: () => void; onCancel: () => void}) {
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
        {figures.warning} This will erase all flash on {port}, including firmware, filesystem, and
        configuration.
      </Text>
      <Text color="yellow">This cannot be undone.</Text>
      <Text>
        {'\n'}Continue? <Text bold>(y/N)</Text>
      </Text>
    </Box>
  )
}

function EraseProgress(props: {esptoolPath: string; port: string; baudRate: number}) {
  const {esptoolPath, port, baudRate} = props

  const observable = useMemo((): Observable<SpawnState> => {
    return ospawn(esptoolPath, ['--port', port, '--baud', String(baudRate), 'erase-flash'])
  }, [esptoolPath, port, baudRate])

  const progress = useObservable(observable, INITIAL_SPAWN_STATE)
  const {output, error, completed} = progress

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
        Erasing flash on {port}
        {error ? <Text> failed</Text> : null}
      </Text>
      {output.map((chunk, i) => (
        <Text key={i} color={chunk.type === 'err' ? 'red' : 'gray'}>
          {textDecoder.decode(chunk.output)}
        </Text>
      ))}
      {error && <Text color="red">{error.stack}</Text>}
    </Box>
  )
}

const textDecoder = new TextDecoder()
