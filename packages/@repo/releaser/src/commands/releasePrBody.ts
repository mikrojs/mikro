import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {formatChangelog} from '../util/changelogFormat.js'
import {findLastReleaseTag, getCommitsSince} from '../util/commits.js'

export const args = command(
  'release-pr-body',
  object({
    action: constant('release-pr-body' as const),
    base: option('--base', string({metavar: 'VERSION'}), {
      description: message`Previous released version`,
    }),
    tentative: option('--tentative', string({metavar: 'VERSION'}), {
      description: message`Upcoming version`,
    }),
  }),
  {description: message`Print a markdown PR body for the rolling release PR`},
)

type Args = InferValue<typeof args>

export async function run(opts: Args): Promise<void> {
  // findLastReleaseTag returns null when no v* tag is reachable from HEAD;
  // pass that through so getCommitsSince walks all commits. Don't synthesize
  // `v${opts.base}` — that tag may not exist (e.g. before the first release).
  const lastTag = findLastReleaseTag()
  const commits = getCommitsSince(lastTag)

  const lines = [
    `Releasing **v${opts.tentative}** (previous: \`v${opts.base}\`).`,
    '',
    `Merging this PR publishes \`v${opts.tentative}\` to npm and creates a GitHub Release.`,
    '',
    `### Pending changes (${commits.length} commits)`,
    '',
    formatChangelog(commits),
  ]
  process.stdout.write(lines.join('\n'))
}
