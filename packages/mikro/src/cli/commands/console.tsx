import type {InferValue} from '@optique/core/parser'

import {DevicePicker} from '../components/DevicePicker.js'
import {FirmwareGate} from '../lib/serial/FirmwareGate.js'
import {InkReplMode} from '../lib/serial/InkReplMode.js'
import {runAgentRepl} from '../lib/serial/runAgentRepl.js'
import type {args} from './console.args.js'

type Props = {
  args: InferValue<typeof args>
}

export async function run(config: InferValue<typeof args>) {
  return runAgentRepl(
    {port: config.port, recover: config.recover === true, yes: config.yes === true},
    {
      command: 'console',
      nextActions: [
        {command: 'mikro dev', description: 'Start device development'},
        {command: 'mikro deploy', description: 'Deploy to device'},
      ],
    },
  )
}

export default function ConsoleCmd(props: Props) {
  const {port, recover, yes} = props.args
  return (
    <DevicePicker port={port}>
      {(device) => (
        <FirmwareGate devicePath={device.path} command="console" yes={yes === true}>
          {(compat) => (
            <InkReplMode
              devicePath={device.path}
              serialNumber={device.serialNumber}
              recover={recover === true}
              compat={compat}
            />
          )}
        </FirmwareGate>
      )}
    </DevicePicker>
  )
}
