import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {port} from '../../lib/portValueParser.js'

export const args = command(
  'enroll',
  object({
    subcommand: constant('enroll' as const),
    registry: optional(
      option('--registry', string({metavar: 'URL'}), {
        description: message`Registry base URL (default: .mikro/registry.json)`,
      }),
    ),
    token: optional(
      option('--token', string({metavar: 'TOKEN'}), {
        description: message`Registry API token (default: MIKRO_OTA_TOKEN or .mikro/registry.json)`,
      }),
    ),
    name: optional(
      option('--name', string({metavar: 'NAME'}), {
        description: message`Name for the device (default: derived from its device id)`,
      }),
    ),
    channel: optional(
      option('--channel', string({metavar: 'CHANNEL'}), {
        description: message`Update channel the device follows (e.g. beta, stable); default main`,
      }),
    ),
    reEnroll: optional(
      flag('--re-enroll', {
        description: message`Rotate the update key when the device is already enrolled (the old one stops working immediately)`,
      }),
    ),
    updateKey: optional(
      option('--update-key', string({metavar: 'SECRET'}), {
        description: message`Write an externally issued update key to the device; the registry is not contacted`,
      }),
    ),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
  {description: message`Enroll the connected device with an update registry`},
)
