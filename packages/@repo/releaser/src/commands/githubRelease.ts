/* eslint-disable no-console */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import semver from 'semver'

import {octokit, repoSlug} from '../util/octokit.js'
import {MONOREPO_ROOT} from '../util/repo.js'

export const args = command(
  'github-release',
  object({
    action: constant('github-release' as const),
    version: option('--version', string({metavar: 'VERSION'}), {
      description: message`Version to release (without leading v, e.g. 0.2.0)`,
    }),
    latest: optional(
      flag('--latest', {
        description: message`Mark as the "Latest" release on GitHub. Skip for prereleases.`,
      }),
    ),
  }),
  {
    description: message`Create a GitHub Release with install instructions and the changelog`,
  },
)

type Args = InferValue<typeof args>

const INSTALL_LATEST = `## Install latest

\`\`\`sh
# Create new project
pnpm create mikro

# Upgrade existing project
pnpm add mikro
pnpm mikro flash
\`\`\``

function installPinned(version: string): string {
  return `## Install v${version}

\`\`\`sh
# Create new project
pnpm create mikro@${version}

# Upgrade existing project
pnpm add mikro@${version}
pnpm mikro flash
\`\`\``
}

// Extract the changelog section for `version` from CHANGELOG.md.
// Matches `## <version>` (with optional `(date)` suffix), captures until the
// next `## ` heading. Exported for tests.
export function extractChangelogSection(content: string, version: string): string {
  const lines = content.split('\n')
  const headingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`)
  let inSection = false
  const captured: string[] = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inSection) break // next section
      if (headingRe.test(line)) {
        inSection = true
        continue // skip the heading itself; the release page shows the version
      }
    }
    if (inSection) captured.push(line)
  }
  return captured.join('\n').trim()
}

function readChangelog(version: string): string {
  const path = join(MONOREPO_ROOT, 'CHANGELOG.md')
  return extractChangelogSection(readFileSync(path, 'utf-8'), version)
}

function composeBody(version: string): string {
  const changelog = readChangelog(version)
  if (!changelog) {
    throw new Error(
      `No changelog section found for ${version} in CHANGELOG.md. ` +
        `Run 'releaser changelog --version ${version}' to generate it before releasing.`,
    )
  }
  return (
    [INSTALL_LATEST, '', installPinned(version), '', '## Changelog', '', changelog].join('\n') +
    '\n'
  )
}

// Idempotent create: if a release for the tag already exists (failed mid-run
// of an earlier invocation), update it in place instead of erroring with 422.
async function createOrUpdateRelease(
  gh: ReturnType<typeof octokit>,
  owner: string,
  repo: string,
  params: {tag: string; body: string; isPrerelease: boolean; makeLatest: boolean},
): Promise<{id: number; html_url: string}> {
  const {tag, body, isPrerelease, makeLatest} = params
  try {
    const {data} = await gh.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: tag,
      body,
      make_latest: makeLatest ? 'true' : 'false',
      prerelease: isPrerelease,
    })
    return {id: data.id, html_url: data.html_url}
  } catch (err) {
    const status = (err as {status?: number}).status
    if (status !== 422) throw err
    console.error(`Release ${tag} already exists; updating in place`)
    const {data: existing} = await gh.repos.getReleaseByTag({owner, repo, tag})
    const {data: updated} = await gh.repos.updateRelease({
      owner,
      repo,
      release_id: existing.id,
      body,
      make_latest: makeLatest ? 'true' : 'false',
      prerelease: isPrerelease,
    })
    return {id: updated.id, html_url: updated.html_url}
  }
}

export async function run(opts: Args): Promise<void> {
  if (!semver.valid(opts.version)) {
    throw new Error(`Invalid semver: ${opts.version}`)
  }
  const isPrerelease = Boolean(semver.prerelease(opts.version))
  if (opts.latest && isPrerelease) {
    // Defense in depth: the workflow only passes --latest in `release` mode
    // (where `tag` already rejects prereleases), but the CLI is invokable
    // manually. Refuse rather than silently downgrading make_latest.
    throw new Error(`Refusing to mark prerelease ${opts.version} as latest`)
  }
  const tag = `v${opts.version}`
  const makeLatest = opts.latest === true

  const {owner, repo} = repoSlug()
  const gh = octokit()
  const body = composeBody(opts.version)

  console.error(`Creating GitHub Release ${tag} (latest=${makeLatest}, prerelease=${isPrerelease})`)
  const release = await createOrUpdateRelease(gh, owner, repo, {
    tag,
    body,
    isPrerelease,
    makeLatest,
  })

  console.error(`Release ready: ${release.html_url}`)
}
