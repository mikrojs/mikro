import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag, option} from '@optique/core/primitives'
import {integer, string} from '@optique/core/valueparser'

export const args = command(
  'build',
  object({
    subcommand: constant('build' as const),
    board: optional(
      option('--board', string({metavar: 'BOARD'}), {
        description: message`Build only this board: its key in boards.config.ts (./t-display) or its name. Without a name, it asks`,
      }),
    ),
    image: optional(
      option('--image', string({metavar: 'IMAGE'}), {
        description: message`Build only this image of each board, full or one of its "images" (no-ble), and keep the others. Without a name, it asks`,
      }),
    ),
    parallel: optional(
      option('--parallel', integer({metavar: 'N', min: 1}), {
        description: message`Build up to N images at once, across boards, each with its output in a log beside its build folder`,
      }),
    ),
    flash: optional(
      flag('--flash', {
        description: message`Then flash the image it built, as mikro flash does. Needs one board and, for a board with other images, --image`,
      }),
    ),
  }),
  {
    description: message`Build the boards in boards.config.ts and write their images where the package's "firmware" exports point`,
  },
)
