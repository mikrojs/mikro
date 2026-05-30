/* eslint-disable no-console */
import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {integer, string} from '@optique/core/valueparser'

import {octokit, repoSlug} from '../util/octokit.js'

const MARKER = '<!-- releaser:preview -->'

export const args = command(
  'comment-pr',
  object({
    action: constant('comment-pr' as const),
    pr: option('--pr', integer({metavar: 'N'}), {description: message`Pull request number`}),
    version: option('--version', string({metavar: 'VERSION'}), {
      description: message`Published version (e.g. 0.2.0-pr-121.20260426T120000+abc1234)`,
    }),
    tag: option('--tag', string({metavar: 'DIST_TAG'}), {
      description: message`npm dist-tag the version was published under (e.g. pr-121)`,
    }),
  }),
  {description: message`Upsert a sticky preview-published comment on a PR`},
)

type CommentArgs = InferValue<typeof args>

function body(version: string, tag: string): string {
  return [
    MARKER,
    '',
    `🚀 Preview published: \`v${version}\``,
    '',
    'Install with:',
    '',
    '```sh',
    `pnpm add mikro@${tag}`,
    '```',
  ].join('\n')
}

export async function run(opts: CommentArgs): Promise<void> {
  const {owner, repo} = repoSlug()
  const gh = octokit()

  const {data: comments} = await gh.issues.listComments({
    owner,
    repo,
    issue_number: opts.pr,
    per_page: 100,
  })
  const existing = comments.find((c) => c.body?.startsWith(MARKER))

  const text = body(opts.version, opts.tag)
  if (existing) {
    if (existing.body === text) {
      console.error(`Sticky preview comment already up to date on PR #${opts.pr}`)
      return
    }
    await gh.issues.updateComment({owner, repo, comment_id: existing.id, body: text})
    console.error(`Updated sticky preview comment on PR #${opts.pr}`)
  } else {
    await gh.issues.createComment({owner, repo, issue_number: opts.pr, body: text})
    console.error(`Created sticky preview comment on PR #${opts.pr}`)
  }
}
