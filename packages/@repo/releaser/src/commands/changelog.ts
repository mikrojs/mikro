/* eslint-disable no-console */
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {formatChangelog} from '../util/changelogFormat.js'
import {findReleaseBase, getCommitsSince} from '../util/commits.js'
import {MONOREPO_ROOT} from '../util/repo.js'
import {getPublishablePackages} from '../util/workspace.js'

export const args = command(
  'changelog',
  object({
    action: constant('changelog' as const),
    version: option('--version', string({metavar: 'VERSION'}), {
      description: message`Version being released (used as the section heading)`,
    }),
    rootOnly: optional(
      flag('--root-only', {description: message`Only update the root CHANGELOG.md`}),
    ),
  }),
  {
    description: message`Prepend a CHANGELOG.md section to root and (by default) every coordinated package`,
  },
)

type ChangelogArgs = InferValue<typeof args>

function prepend(path: string, section: string): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '# Changelog\n\n'
  const [firstLine, ...rest] = existing.split('\n')
  const header = firstLine?.startsWith('# ') ? firstLine : '# Changelog'
  const body = firstLine?.startsWith('# ') ? rest.join('\n').replace(/^\n+/, '') : existing
  const next = `${header}\n\n${section}\n${body}`.replace(/\n+$/, '\n')
  writeFileSync(path, next)
}

export async function run(opts: ChangelogArgs): Promise<void> {
  const base = findReleaseBase()
  const commits = getCommitsSince(base)
  console.error(
    `Generating changelog for ${commits.length} commits since ${base?.slice(0, 7) ?? 'repo start'}`,
  )

  const date = new Date().toISOString().slice(0, 10)
  const heading = `## ${opts.version} (${date})\n\n`
  const section = heading + formatChangelog(commits)

  prepend(join(MONOREPO_ROOT, 'CHANGELOG.md'), section)

  if (opts.rootOnly) return

  const packages = getPublishablePackages()
  for (const pkg of packages) {
    prepend(join(pkg.path, 'CHANGELOG.md'), section)
  }
  console.error(`Updated ${packages.length + 1} CHANGELOG.md files`)
}
