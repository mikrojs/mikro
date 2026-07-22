import {command, constant, message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {flag} from '@optique/core/primitives'
import {Box, Text} from 'ink'
import {SerialPort} from 'serialport'

import {useDevices} from '../hooks/useDevices.js'
import {agentResult, isAgentMode} from '../lib/agent.js'
import {getCachedChip, getCachedDeviceId, getCachedName} from '../lib/deviceCache.js'
import {deviceIdFromSerial} from '../lib/deviceId.js'
import {formatDeviceList} from '../lib/deviceLabel.js'
import {deviceDisplayName, deviceGeneratedName} from '../lib/deviceName.js'

export const args = command(
  'ls',
  object({
    action: constant('list'),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
)

export async function run(config: InferValue<typeof args>) {
  const ports = (await SerialPort.list()).filter((p) => p.serialNumber)

  if (config.json === true || isAgentMode(config.agent)) {
    const devices = ports.map((d) => ({
      ...d,
      // `name` is the intrinsic generated name; `deviceName` is the optional
      // name the device reported for itself. They stay distinct here — `name`
      // does not change when a name is set on the device.
      name: deviceGeneratedName(d.serialNumber),
      deviceName: getCachedName(d.serialNumber),
      deviceId: deviceIdFromSerial(d.serialNumber) ?? getCachedDeviceId(d.serialNumber),
      chip: getCachedChip(d.serialNumber),
    }))
    const nextActions = devices.map((d) => ({
      command: `mikro console -p ${d.deviceName ?? d.path}`,
      // Never the derived `name`: `-p` deliberately does not resolve one, so
      // naming it here hands the reader a token that cannot be used.
      description: `Connect to ${deviceDisplayName(d.serialNumber, d.deviceId)} (${d.serialNumber})`,
    }))
    agentResult('ls', devices, [
      ...nextActions,
      {command: 'mikro dev', description: 'Start device development'},
      {command: 'mikro deploy', description: 'Deploy to device'},
    ])
    return
  }

  if (ports.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No devices found')
    return
  }

  for (const line of formatDeviceList(ports)) {
    // eslint-disable-next-line no-console
    console.log(line)
  }
}

type Props = {
  args: InferValue<typeof args>
}

export default function Ls(_props: Props) {
  const portsResult = useDevices()
  if (portsResult.status === 'error') {
    return <Text>Could not load serial ports: {portsResult.error.message}</Text>
  }
  if (portsResult.status === 'loading') {
    return <Text>Discovering devices…</Text>
  }
  const ports = portsResult.value
  if (ports.length === 0) {
    return <Text>No devices found</Text>
  }
  return (
    <Box flexDirection="column">
      {formatDeviceList(ports).map((line, i) => (
        <Text key={ports[i]!.path}>{line}</Text>
      ))}
    </Box>
  )
}
