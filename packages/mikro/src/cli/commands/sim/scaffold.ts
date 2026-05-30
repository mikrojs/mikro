/* eslint-disable no-console */
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag} from '@optique/core/primitives'

import type {BuiltinName} from '../../../simulator/builtins/types.js'
import {getScaffoldTemplate, SCAFFOLDABLE_BUILTINS} from '../../../simulator/simTemplates.js'

export const args = command(
  'scaffold',
  object({
    subcommand: constant('scaffold' as const),
    overwrite: optional(flag('--overwrite', {description: message`Overwrite existing stub files`})),
  }),
  {description: message`Generate simulator stub files for hardware builtins in sim/`},
)

export function run(config: {overwrite?: boolean}): void {
  const overwrite = config.overwrite === true
  const simDir = pathlib.join(process.cwd(), 'sim')
  let created = 0

  for (const name of SCAFFOLDABLE_BUILTINS) {
    const template = getScaffoldTemplate(name as BuiltinName)
    if (!template) continue

    const filePath = pathlib.join(simDir, `${name}.stub.ts`)
    const exists = existsSync(filePath)
    if (exists && !overwrite) {
      console.log(`  skip       sim/${name}.stub.ts (already exists)`)
      continue
    }

    mkdirSync(simDir, {recursive: true})
    writeFileSync(filePath, template)
    console.log(`  ${exists ? 'overwrite' : 'create   '}  sim/${name}.stub.ts`)
    created++
  }

  if (created === 0) {
    console.log('All stubs already exist (use --overwrite to replace)')
  } else {
    console.log(`\nCreated ${created} stub(s) in sim/`)
    console.log('Edit them to customize hardware behavior for development and testing.')
    console.log('Note: stubs run inside the mikrojs runtime (QuickJS), not Node.js.')
    console.log('Node built-ins (fs, fetch, etc.) are not available.')
  }
}
