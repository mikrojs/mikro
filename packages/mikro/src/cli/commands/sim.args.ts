import {command, constant} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'

import {args as cleanArgs} from './sim/clean.args.js'
import {args as deployArgs} from './sim/deploy.args.js'
import {args as devArgs} from './sim/dev.args.js'
import {args as envArgs} from './sim/env.args.js'
import {args as profileArgs} from './sim/profile.args.js'
import {args as replArgs} from './sim/repl.args.js'
import {args as resetArgs} from './sim/reset.args.js'
import {args as scaffoldArgs} from './sim/scaffold.args.js'
import {args as testArgs} from './sim/test.args.js'

export const args = command(
  'sim',
  objectConstruct({
    action: constant('sim'),
    sub: orConstruct(
      devArgs,
      deployArgs,
      replArgs,
      testArgs,
      envArgs,
      cleanArgs,
      resetArgs,
      profileArgs,
      scaffoldArgs,
    ),
  }),
)
