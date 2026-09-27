import {message, or} from '@optique/core'
import {object} from '@optique/core/constructs'
import {defineProgram} from '@optique/core/program'

import pkg from '../../package.json' with {type: 'json'}
import {args as buildArgs} from './commands/build.args.js'
import {args as cleanArgs} from './commands/clean.args.js'
import {args as consoleArgs} from './commands/console.args.js'
import {args as deployArgs} from './commands/deploy.args.js'
import {args as devArgs} from './commands/dev.args.js'
import {args as docsArgs} from './commands/docs.args.js'
import {args as envArgs} from './commands/env.args.js'
import {args as eraseArgs} from './commands/erase.args.js'
import {args as flashArgs} from './commands/flash.args.js'
import {args as fwArgs} from './commands/fw.args.js'
import {args as homeArgs} from './commands/home.args.js'
import {args as idfArgs} from './commands/idf.args.js'
import {args as logsArgs} from './commands/logs.args.js'
import {args as listArgs} from './commands/ls.args.js'
import {args as nameArgs} from './commands/name.args.js'
import {args as otaArgs} from './commands/ota.args.js'
import {args as profileArgs} from './commands/profile.args.js'
import {args as simArgs} from './commands/sim.args.js'
import {args as testArgs} from './commands/test.args.js'

// Only the parsers load here; cli.ts imports each command's handler module
// after parsing, so a run pays for one command's dependencies, not all.
export const argsParser = or(
  or(
    object({command: devArgs}),
    object({command: deployArgs}),
    object({command: envArgs}),
    object({command: buildArgs}),
    object({command: flashArgs}),
    object({command: consoleArgs}),
    object({command: nameArgs}),
    object({command: fwArgs}),
  ),
  or(
    object({command: listArgs}),
    object({command: eraseArgs}),
    object({command: cleanArgs}),
    object({command: testArgs}),
    object({command: simArgs}),
    object({command: docsArgs}),
    object({command: homeArgs}),
    object({command: logsArgs}),
    object({command: otaArgs}),
    object({command: profileArgs}),
    object({command: idfArgs}),
  ),
)

const name: keyof typeof pkg.bin = 'mikro'

export const prog = defineProgram({
  parser: argsParser,
  metadata: {
    name,
    version: pkg.version,
    author: message`Bjørge Næss <bjoerge@gmail.com>`,
    bugs: message`https://github.com/mikrojs/mikro/issues`,
  },
})
