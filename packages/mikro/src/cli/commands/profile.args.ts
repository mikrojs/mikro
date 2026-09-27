import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {port} from '../lib/portValueParser.js'

export const args = command(
  'profile',
  object({
    action: constant('profile'),
    port: optional(option('-p', '--port', port(), {description: message`Serial port of device`})),
    write: optional(
      flag('--write', {
        description: message`Record this run's reading as the committed boot snapshot (__heap_snapshots__/<chip>.json). Without it the command only reports. Drift under the tolerance is left alone.`,
      }),
    ),
    heapTolerance: optional(
      option('--heap-tolerance', string({metavar: 'SIZE'}), {
        description: message`Heap drift below which the snapshot is neither flagged nor rewritten (default: max(256, 1% of stored)). Accepts a K/M suffix.`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`NDJSON agent mode`})),
  }),
  {
    description: message`Report the memory a device leaves for an app: the JS budget before \`mem_limit\` throws, and the free system heap, both as they stood before the app was evaluated. Compares against the committed boot snapshot, which \`mikro test\` also records.`,
  },
)
