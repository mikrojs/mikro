import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag, option} from '@optique/core/primitives'

import {port} from '../lib/portValueParser.js'

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
    yes: optional(
      flag('-y', '--yes', {
        description: message`If the device firmware is incompatible, flash CLI-matched firmware without prompting`,
      }),
    ),
  }),
)
