/* eslint-disable no-console */
import {spawnSync} from 'node:child_process'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {MONOREPO_ROOT} from '../util/repo.js'
import {getPublishablePackages} from '../util/workspace.js'

export const args = command(
  'publish',
  object({
    action: constant('publish' as const),
    tag: option('--tag', string({metavar: 'DIST_TAG'}), {
      description: message`npm dist-tag (latest, next, canary, pr-N)`,
    }),
    dryRun: optional(flag('--dry-run', {description: message`Pack tarballs but skip npm publish`})),
  }),
  {description: message`Publish all coordinated packages to npm under <tag>`},
)

type PublishArgs = InferValue<typeof args>

function exec(cmd: string, args: string[]): void {
  console.error(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, {cwd: MONOREPO_ROOT, stdio: 'inherit'})
  if (r.status !== 0) {
    throw new Error(`${cmd} exited with status ${r.status}`)
  }
}

// Build the same `--filter <name>` list that bump/changelog operate on.
// Avoids drift between which packages get version-bumped vs which get published.
function publishableFilters(): string[] {
  const pkgs = getPublishablePackages()
  const filters: string[] = []
  for (const pkg of pkgs) {
    filters.push('--filter', pkg.name)
  }
  return filters
}

export async function run(opts: PublishArgs): Promise<void> {
  const filters = publishableFilters()
  if (filters.length === 0) {
    throw new Error('No publishable packages found')
  }

  if (opts.dryRun) {
    exec('pnpm', ['-r', ...filters, 'pack', '--pack-destination', '/tmp'])
    console.error(`[dry-run] Would publish ${filters.length / 2} packages with --tag ${opts.tag}`)
    return
  }

  exec('pnpm', [
    '-r',
    ...filters,
    'publish',
    '--access',
    'public',
    '--no-git-checks',
    '--tag',
    opts.tag,
  ])
}
