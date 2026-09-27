import {command, constant, message, object, optional} from '@optique/core'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {port} from '../lib/portValueParser.js'

export const args = command(
  'erase',
  object({
    action: constant('erase'),
    port: optional(
      option('-p', '--port', port(), {
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
