/* eslint-disable no-console */
import {spawnSync} from 'node:child_process'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {isPublished} from '../util/registry.js'
import {MONOREPO_ROOT} from '../util/repo.js'
import {stripBuildMetadata} from '../util/version.js'
import {getPublishablePackages, type PnpmPackage} from '../util/workspace.js'

export const args = command(
  'publish',
  object({
    action: constant('publish' as const),
    tag: option('--tag', string({metavar: 'DIST_TAG'}), {
      description: message`npm dist-tag (latest, next, canary, pr-N)`,
    }),
    skipExisting: optional(
      flag('--skip-existing', {
        description: message`Skip packages already on npm at their current version instead of failing. Used by preview modes so re-triggering with no new commits is a no-op, not a workflow error.`,
      }),
    ),
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
function filtersFor(pkgs: PnpmPackage[]): string[] {
  return pkgs.flatMap((pkg) => ['--filter', pkg.name])
}

// Pure: given the candidate packages and (when --skip-existing) a registry
// predicate, return the subset to actually publish. Exported for tests.
// `published` is injected so the selection logic is testable without npm I/O.
export function selectPackagesToPublish(
  pkgs: PnpmPackage[],
  skipExisting: boolean,
  published: (name: string, version: string) => boolean,
): PnpmPackage[] {
  if (!skipExisting) return pkgs
  return pkgs.filter((pkg) => !published(pkg.name, pkg.version))
}

export async function run(opts: PublishArgs): Promise<void> {
  const candidates = getPublishablePackages()
  if (candidates.length === 0) {
    throw new Error('No publishable packages found')
  }

  // --skip-existing: drop packages already on the registry at their current
  // version so re-running a partially failed publish (which reuses the plan
  // job's version) finishes the missing packages instead of failing the
  // workflow on a duplicate-publish error. Local versions carry `+sha` build
  // metadata that pnpm strips at publish, so the lookup must use the stripped
  // version — that's the string the registry knows. Resolve the registry
  // lookups up front so selectPackagesToPublish stays pure and sync.
  const onRegistry = new Set<string>()
  if (opts.skipExisting) {
    await Promise.all(
      candidates.map(async (pkg) => {
        if (await isPublished(pkg.name, stripBuildMetadata(pkg.version))) {
          onRegistry.add(`${pkg.name}@${pkg.version}`)
        }
      }),
    )
  }
  const pkgs = selectPackagesToPublish(candidates, opts.skipExisting === true, (name, version) =>
    onRegistry.has(`${name}@${version}`),
  )
  if (opts.skipExisting) {
    const skipped = candidates.length - pkgs.length
    if (skipped > 0) {
      console.error(
        `[releaser] --skip-existing: ${skipped}/${candidates.length} package(s) already published`,
      )
    }
    if (pkgs.length === 0) {
      console.error('[releaser] nothing to publish; all packages already at this version')
      return
    }
  }

  const filters = filtersFor(pkgs)

  if (opts.dryRun) {
    exec('pnpm', ['-r', ...filters, 'pack', '--pack-destination', '/tmp'])
    console.error(`[dry-run] Would publish ${pkgs.length} packages with --tag ${opts.tag}`)
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
