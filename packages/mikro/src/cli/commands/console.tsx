import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'

import {DevicePicker} from '../components/DevicePicker.js'
import {port} from '../lib/portValueParser.js'
import {InkReplMode} from '../lib/serial/InkReplMode.js'
import {runAgentRepl} from '../lib/serial/runAgentRepl.js'

export const args = command(
  'console',
  object({
    action: constant('console'),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port to connect to. Auto-detected if omitted.`,
      }),
    ),
    agent: optional(flag('--agent', {description: message`NDJSON agent protocol over stdio`})),
    recover: optional(
      flag('--recover', {
        description: message`Reset the device and force safe mode (skips autorun). Use when the deployed app is crash-looping.`,
      }),
    ),
  }),
)

type Props = {
  args: InferValue<typeof args>
}

export async function run(config: InferValue<typeof args>) {
  return runAgentRepl(
    {port: config.port, recover: config.recover === true},
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
  const {port, recover} = props.args
  return (
    <DevicePicker port={port}>
      {(device) => <InkReplMode devicePath={device.path} recover={recover === true} />}
    </DevicePicker>
  )
}
