import type {InferValue} from '@optique/core/parser'

import type {args} from './fw.args.js'
import * as buildSub from './fw/build.js'
import * as checkSub from './fw/check.js'
import * as listSub from './fw/list.js'
import * as packSub from './fw/pack.js'

export async function run(config: InferValue<typeof args>): Promise<void> {
  const {sub} = config
  if (sub.subcommand === 'pack') await packSub.run(sub)
  else if (sub.subcommand === 'build') await buildSub.run(sub)
  else if (sub.subcommand === 'list') await listSub.run(sub)
  else await checkSub.run(sub)
}
