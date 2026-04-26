#!/usr/bin/env -S pnpm tsx
/* eslint-disable no-console */
import {message, or} from '@optique/core'
import {object} from '@optique/core/constructs'
import {defineProgram} from '@optique/core/program'
import {run} from '@optique/run'

import pkg from '../package.json' with {type: 'json'}
import * as bumpCommand from '../src/commands/bump.js'
import * as changelogCommand from '../src/commands/changelog.js'
import * as commentPrCommand from '../src/commands/commentPr.js'
import * as planCommand from '../src/commands/plan.js'
import * as publishCommand from '../src/commands/publish.js'
import * as releasePrBodyCommand from '../src/commands/releasePrBody.js'
import * as tagCommand from '../src/commands/tag.js'
import * as unlabelPreviewCommand from '../src/commands/unlabelPreview.js'

const argsParser = or(
  object({command: planCommand.args}),
  object({command: bumpCommand.args}),
  object({command: changelogCommand.args}),
  object({command: releasePrBodyCommand.args}),
  object({command: publishCommand.args}),
  object({command: commentPrCommand.args}),
  object({command: tagCommand.args}),
  object({command: unlabelPreviewCommand.args}),
)

const prog = defineProgram({
  parser: argsParser,
  metadata: {
    name: 'releaser',
    version: pkg.version,
    description: message`Release tooling for mikrojs`,
  },
})

const parsed = run(prog)

try {
  switch (parsed.command.action) {
    case 'plan':
      await planCommand.run(parsed.command)
      break
    case 'bump':
      await bumpCommand.run(parsed.command)
      break
    case 'changelog':
      await changelogCommand.run(parsed.command)
      break
    case 'release-pr-body':
      await releasePrBodyCommand.run(parsed.command)
      break
    case 'publish':
      await publishCommand.run(parsed.command)
      break
    case 'comment-pr':
      await commentPrCommand.run(parsed.command)
      break
    case 'tag':
      await tagCommand.run(parsed.command)
      break
    case 'unlabel-preview':
      await unlabelPreviewCommand.run(parsed.command)
      break
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
