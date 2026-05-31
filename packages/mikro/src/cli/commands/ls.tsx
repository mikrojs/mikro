import {command, constant, message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {flag} from '@optique/core/primitives'
import {Text} from 'ink'
import {SerialPort} from 'serialport'

import {useDevices} from '../hooks/useDevices.js'
import {agentResult, isAgentMode} from '../lib/agent.js'
import {deviceDisplayName, getDeviceAlias} from '../lib/deviceAliases.js'
import {getCachedChip, getCachedDeviceId} from '../lib/deviceCache.js'
import {deviceIdFromSerial} from '../lib/deviceId.js'
import Table from '../lib/ink-table/index.js'

const COLUMNS = {
  name: 'Name',
  chip: 'Chip',
  path: 'Path',
  manufacturer: 'Manufacturer',
  serialNumber: 'Serial Number',
  locationId: 'Location ID',
  vendorId: 'Vendor ID',
  productId: 'Product ID',
  pnpId: 'PNP ID',
}

export const args = command(
  'ls',
  object({
    action: constant('list'),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
)

export async function run(config: InferValue<typeof args>) {
  const devices = (await SerialPort.list())
    .filter((p) => p.serialNumber)
    .map((d) => ({
      ...d,
      name: deviceDisplayName(d.serialNumber),
      alias: getDeviceAlias(d.serialNumber),
      deviceId: deviceIdFromSerial(d.serialNumber) ?? getCachedDeviceId(d.serialNumber),
      chip: getCachedChip(d.serialNumber),
    }))

  if (config.json === true || isAgentMode(config.agent)) {
    const nextActions = devices.map((d) => ({
      command: `mikro console -p ${d.alias ?? d.path}`,
      description: `Connect to ${d.alias ?? d.manufacturer ?? 'device'} (${d.serialNumber})`,
    }))
    agentResult('ls', devices, [
      ...nextActions,
      {command: 'mikro dev', description: 'Start device development'},
      {command: 'mikro deploy', description: 'Deploy to device'},
    ])
    return
  }

  if (devices.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No devices found')
    return
  }

  for (const d of devices) {
    const label = [d.name, d.chip, d.serialNumber].filter(Boolean).join('  ')
    // eslint-disable-next-line no-console
    console.log(`${d.path}  ${label}`)
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
  const data = ports.map((port) => ({
    name: deviceDisplayName(port.serialNumber),
    chip: getCachedChip(port.serialNumber) ?? '',
    ...port,
  }))
  return <Table data={data} getKey={(port) => port.path} columns={COLUMNS} />
}
