/* eslint-disable no-console */
import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {choice, integer, string} from '@optique/core/valueparser'
import semver from 'semver'

import {findReleaseBase, getCommitsSince} from '../util/commits.js'
import {readGitInfo} from '../util/git.js'
import {MONOREPO_ROOT} from '../util/repo.js'
import {computeVersion, formatTimestamp, recommendBump, type ReleaseType} from '../util/version.js'
import {getPublishablePackages, readCanonicalVersion, writeVersion} from '../util/workspace.js'

export type Mode = 'release' | 'release-preview' | 'canary' | 'pr-preview'

export const args = command(
  'bump',
  object({
    action: constant('bump' as const),
    mode: option(
      '--mode',
      choice(['release', 'canary', 'pr-preview'] as const, {metavar: 'MODE'}),
      {description: message`Release mode`},
    ),
    pr: optional(
      option('--pr', integer({metavar: 'N'}), {
        description: message`Pull request number (required when --mode=pr-preview)`,
      }),
    ),
    useCurrent: optional(
      flag('--use-current', {
        description: message`Use the version already in package.json without recomputing (release mode only). Use this in the publish job after a release PR has merged.`,
      }),
    ),
    set: optional(
      option('--set', string({metavar: 'VERSION'}), {
        description: message`Write the given version to all publishable packages, no computation. Used in firmware/publish jobs to apply the version computed by plan.`,
      }),
    ),
    breakingIsMinorOn0x: optional(
      flag('--breaking-is-minor-on-0x', {
        description: message`While on 0.x, treat breaking changes as minor (downgrade recommended major bumps). Off by default — a recommended major bump from 0.x will cut 1.0.0. No-op on 1.x and later.`,
      }),
    ),
    dryRun: optional(
      flag('--dry-run', {description: message`Print the new version without writing files`}),
    ),
    json: optional(
      flag('--json', {description: message`Emit { version, npmTag, mode } JSON to stdout`}),
    ),
  }),
  {description: message`Compute and write a new version across all coordinated packages`},
)

type BumpArgs = InferValue<typeof args>

export interface BumpResult {
  version: string
  npmTag: string
  mode: Mode
}

export interface BumpInputs {
  mode: Mode
  pr?: number
  useCurrent?: boolean
  breakingIsMinorOn0x?: boolean
  currentVersion: string
  semverIncrement: ReleaseType
  git: {commitHash: string}
  now: Date
}

// Pure: derives the version + npm tag from explicit inputs. No I/O.
// Exported for tests.
export function computeBumpPure(inputs: BumpInputs): BumpResult {
  const {mode, pr, useCurrent, breakingIsMinorOn0x, currentVersion, semverIncrement, git, now} =
    inputs

  if (useCurrent) {
    if (mode !== 'release') {
      throw new Error('--use-current is only valid with --mode=release')
    }
    return {version: currentVersion, npmTag: 'latest', mode: 'release'}
  }

  if (mode === 'release') {
    const version = computeVersion({
      currentVersion,
      semverIncrement,
      preid: undefined,
      suffix: undefined,
      breakingIsMinorOn0x,
    })
    return {version, npmTag: 'latest', mode}
  }

  // All prerelease modes share one shape: a wall-clock timestamp as the
  // prerelease counter (publishes sort by publish time under semver.compare,
  // with no registry or git state to consult) and the commit sha as `+sha`
  // build metadata. The `+sha` is written to package.json and baked into
  // firmware (`sys.version`) for traceability, but pnpm strips it at publish
  // (pnpm#11518) — the registry only ever sees the bare timestamped version.
  // A timestamp rather than a commit count because preview modes run on PR
  // merge refs, where `git describe --first-parent` counts base-branch
  // commits and never advances when the PR itself does. The tradeoff: a
  // version is never reproducible, so re-triggering with no changes publishes
  // again instead of no-op'ing.

  if (mode === 'release-preview') {
    // Triggered by `release:preview` on the rolling release PR, whose
    // package.json is already bumped to the version about to ship. Publish
    // THAT version as a `next` prerelease (no further increment) under the
    // `next` dist-tag: a dry run of the pending release.
    return {
      version: computeVersion({
        currentVersion,
        semverIncrement,
        preid: 'next',
        suffix: formatTimestamp(now),
        build: git.commitHash,
        noIncrement: true,
      }),
      npmTag: 'next',
      mode,
    }
  }

  if (mode === 'canary') {
    return {
      version: computeVersion({
        currentVersion,
        semverIncrement,
        preid: 'canary',
        suffix: formatTimestamp(now),
        build: git.commitHash,
        breakingIsMinorOn0x,
      }),
      npmTag: 'canary',
      mode,
    }
  }

  // pr-preview
  if (typeof pr !== 'number') {
    throw new Error('--mode=pr-preview requires --pr <N>')
  }
  const preid = `pr-${pr}`
  return {
    version: computeVersion({
      currentVersion,
      semverIncrement,
      preid,
      suffix: formatTimestamp(now),
      build: git.commitHash,
      breakingIsMinorOn0x,
    }),
    npmTag: preid,
    mode,
  }
}

async function gather(opts: BumpArgs): Promise<BumpInputs> {
  const useCurrent = opts.useCurrent === true
  // Skip git/recommended-bump I/O when --use-current; computeBumpPure
  // ignores those fields in that path. Still sets them to safe defaults
  // so the BumpInputs shape stays uniform.
  return {
    mode: opts.mode,
    pr: opts.pr,
    useCurrent,
    breakingIsMinorOn0x: opts.breakingIsMinorOn0x === true,
    currentVersion: readCanonicalVersion(),
    semverIncrement: useCurrent ? 'patch' : recommendBump(getCommitsSince(findReleaseBase())),
    git: useCurrent ? {commitHash: ''} : readGitInfo(),
    now: new Date(),
  }
}

function emit(result: BumpResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result))
  } else {
    console.log(result.version)
  }
}

export async function run(opts: BumpArgs): Promise<void> {
  // --set <VERSION>: write-only path. Used in firmware/publish jobs to apply
  // a version computed once by `releaser plan` (one source of truth).
  if (opts.set) {
    if (!semver.valid(opts.set)) {
      throw new Error(`--set: invalid semver: ${opts.set}`)
    }
    const npmTag = semver.prerelease(opts.set) ? 'prerelease' : 'latest'
    const result: BumpResult = {version: opts.set, npmTag, mode: opts.mode}
    if (opts.dryRun) {
      console.error(`[dry-run] Would write ${result.version}`)
      emit(result, opts.json === true)
      return
    }
    const packages = getPublishablePackages()
    console.error(
      `Setting workspace root + ${packages.length} publishable packages to ${result.version}`,
    )
    writeVersion(MONOREPO_ROOT, result.version)
    for (const pkg of packages) {
      writeVersion(pkg.path, result.version)
    }
    emit(result, opts.json === true)
    return
  }

  const inputs = await gather(opts)
  const result = computeBumpPure(inputs)

  // --use-current: nothing to write, version already in place.
  if (inputs.useCurrent) {
    console.error(`Using current version ${result.version} (no files modified)`)
    emit(result, opts.json === true)
    return
  }

  if (opts.dryRun) {
    console.error(`[dry-run] Would write ${result.version}`)
    emit(result, opts.json === true)
    return
  }

  const packages = getPublishablePackages()
  console.error(
    `Bumping workspace root + ${packages.length} publishable packages: ${inputs.currentVersion} → ${result.version}`,
  )

  writeVersion(MONOREPO_ROOT, result.version)
  for (const pkg of packages) {
    writeVersion(pkg.path, result.version)
  }

  emit(result, opts.json === true)
}
