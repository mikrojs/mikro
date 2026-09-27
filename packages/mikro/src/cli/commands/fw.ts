import {command, constant, message, or} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'

import * as buildSub from './fw/build.js'
import * as checkSub from './fw/check.js'
import * as packSub from './fw/pack.js'

export const args = command(
  'fw',
  object({
    action: constant('fw'),
    sub: or(packSub.args, buildSub.args, checkSub.args),
  }),
  {description: message`Pack custom firmware builds and board images`},
)

export async function run(config: InferValue<typeof args>): Promise<void> {
  const {sub} = config
  if (sub.subcommand === 'pack') await packSub.run(sub)
  else if (sub.subcommand === 'build') await buildSub.run(sub)
  else await checkSub.run(sub)
}
