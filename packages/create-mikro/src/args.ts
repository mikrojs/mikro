import {message, object, optional} from '@optique/core'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

export const args = object({
  name: optional(argument(string({metavar: 'NAME'}))),
  template: optional(
    option('-t', '--template', string({metavar: 'TEMPLATE'}), {
      description: message`Template to use`,
    }),
  ),
  chip: optional(
    option('--chip', string({metavar: 'CHIP'}), {
      description: message`The chip a firmware project or board is built for`,
    }),
  ),
  firmware: optional(
    flag('--firmware', {
      description: message`Make the app its own firmware project, for native modules or custom settings`,
    }),
  ),
  board: optional(
    flag('--board', {
      description: message`Create a board package instead: firmware for a development board, and its pins`,
    }),
  ),
})
