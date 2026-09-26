import {command, constant, message, or} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'

import * as checkSub from './fw/check.js'
import * as packSub from './fw/pack.js'
import * as prepackSub from './fw/prepack.js'

export const args = command(
  'fw',
  object({
    action: constant('fw'),
    sub: or(packSub.args, prepackSub.args, checkSub.args),
  }),
  {description: message`Pack custom firmware builds and board images`},
)

export async function run(config: InferValue<typeof args>): Promise<void> {
  const {sub} = config
  if (sub.subcommand === 'pack') await packSub.run(sub)
  else if (sub.subcommand === 'prepack') await prepackSub.run(sub)
  else checkSub.run(sub)
}
