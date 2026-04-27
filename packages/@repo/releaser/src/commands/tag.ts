/* eslint-disable no-console */
import {spawnSync} from 'node:child_process'

import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import semver from 'semver'

import {MONOREPO_ROOT} from '../util/repo.js'

export const args = command(
  'tag',
  object({
    action: constant('tag' as const),
    version: option('--version', string({metavar: 'VERSION'}), {
      description: message`Version to tag, without leading v (e.g. 0.2.0)`,
    }),
  }),
  {description: message`Create and push v<version> git tag`},
)

type TagArgs = InferValue<typeof args>

function gitArgv(argv: string[]): void {
  const r = spawnSync('git', argv, {cwd: MONOREPO_ROOT, stdio: 'inherit'})
  if (r.status !== 0) {
    throw new Error(`git ${argv.join(' ')} exited with status ${r.status}`)
  }
}

export async function run(opts: TagArgs): Promise<void> {
  if (!semver.valid(opts.version)) {
    throw new Error(`Invalid semver: ${opts.version}`)
  }
  // Defense in depth: the workflow only invokes `tag` for release mode, but
  // the CLI is permissive otherwise. Refuse to tag prerelease/preview versions.
  if (semver.prerelease(opts.version)) {
    throw new Error(`Refusing to tag prerelease version: ${opts.version}`)
  }
  const tag = `v${opts.version}`
  console.error(`Creating tag ${tag}…`)
  gitArgv(['tag', tag, '-m', tag])
  gitArgv(['push', 'origin', tag])
  console.error(`Pushed ${tag}`)
}
