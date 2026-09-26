import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {option} from '@optique/core/primitives'
import {integer, string} from '@optique/core/valueparser'
import {path} from '@optique/run'

export const args = command(
  'pack',
  object({
    subcommand: constant('pack' as const),
    out: optional(
      option('--out', path({metavar: 'FILE', allowCreate: true, type: 'file'}), {
        description: message`Output path for the archive (default: ./mikro-fw-<name>-<chip>.tar.gz)`,
      }),
    ),
    board: optional(
      option('--board', string({metavar: 'BOARD'}), {
        description: message`In a board package, pack only this board: its key in boards.config.ts (./t-display) or its name. Without a name, it asks`,
      }),
    ),
    parallel: optional(
      option('--parallel', integer({metavar: 'N', min: 1}), {
        description: message`In a board package, build up to N images at once, across boards, each with its output in a log beside its build folder`,
      }),
    ),
  }),
  {
    description: message`Build the firmware project, or a board package's boards, and pack them for mikro flash --from`,
  },
)
