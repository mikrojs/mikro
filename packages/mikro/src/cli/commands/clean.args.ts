import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag, option} from '@optique/core/primitives'

import {port} from '../lib/portValueParser.js'

export const args = command(
  'clean',
  object({
    action: constant('clean'),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device`,
      }),
    ),
    full: optional(
      flag('--full', {
        description: message`Remove all files and environment variables (not just the deployed app)`,
      }),
    ),
    recover: optional(
      flag('--recover', {
        description: message`Reset the device into safe mode before cleaning. Use when the deployed app is crash-looping.`,
      }),
    ),
    yes: optional(
      flag('-y', '--yes', {
        description: message`Skip confirmation prompt`,
      }),
    ),
  }),
  {description: message`Remove deployed app from device`},
)
