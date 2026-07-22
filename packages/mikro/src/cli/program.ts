import {message, or} from '@optique/core'
import {object} from '@optique/core/constructs'
import {defineProgram} from '@optique/core/program'

import pkg from '../../package.json' with {type: 'json'}
import * as buildCommand from './commands/build.js'
import * as buildRuntimeCommand from './commands/build-runtime.js'
import * as cleanCommand from './commands/clean.js'
import * as consoleCommand from './commands/console.js'
import * as deployCommand from './commands/deploy.js'
import * as devCommand from './commands/dev.js'
import * as docsCommand from './commands/docs.js'
import * as envCommand from './commands/env.js'
import * as eraseCommand from './commands/erase.js'
import * as flashCommand from './commands/flash.js'
import * as homeCommand from './commands/home.js'
import * as logsCommand from './commands/logs.js'
import * as listCommand from './commands/ls.js'
import * as nameCommand from './commands/name.js'
import * as otaCommand from './commands/ota.js'
import * as simCommand from './commands/sim.js'
import * as testCommand from './commands/test.js'

export {
  buildCommand,
  buildRuntimeCommand,
  cleanCommand,
  consoleCommand,
  deployCommand,
  devCommand,
  docsCommand,
  envCommand,
  eraseCommand,
  flashCommand,
  homeCommand,
  listCommand,
  logsCommand,
  nameCommand,
  otaCommand,
  simCommand,
  testCommand,
}

export const commands = {
  name: nameCommand,
  flash: flashCommand,
  build: buildCommand,
  'build-runtime': buildRuntimeCommand,
  clean: cleanCommand,
  docs: docsCommand,
  erase: eraseCommand,
  env: envCommand,
  dev: devCommand,
  deploy: deployCommand,
  list: listCommand,
  console: consoleCommand,
  home: homeCommand,
  logs: logsCommand,
  test: testCommand,
  sim: simCommand,
  ota: otaCommand,
}

export const argsParser = or(
  or(
    object({command: commands.dev.args}),
    object({command: commands.deploy.args}),
    object({command: commands.env.args}),
    object({command: commands.build.args}),
    object({command: commands.flash.args}),
    object({command: commands.console.args}),
    object({command: commands.name.args}),
  ),
  or(
    object({command: commands.list.args}),
    object({command: commands.erase.args}),
    object({command: commands.clean.args}),
    object({command: commands['build-runtime'].args}),
    object({command: commands.test.args}),
    object({command: commands.sim.args}),
    object({command: commands.docs.args}),
    object({command: commands.home.args}),
    object({command: commands.logs.args}),
    object({command: commands.ota.args}),
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
