/* eslint-disable no-console */
import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {choice} from '@optique/core/valueparser'

import {RELEASE_BRANCH} from '../util/constants.js'
import {octokit, repoSlug} from '../util/octokit.js'

// Keeps the rolling release PR from being merged mid-regeneration: `start`
// converts it to a draft (unmergeable) and prepends a caution notice,
// `finish` removes the notice. The PR stays a draft — marking it ready for
// review is the human act of deciding to release.

const CAUTION_BLOCK = [
  '> [!CAUTION]',
  '> This release PR is being regenerated for new commits on main. Hold off merging until this notice disappears.',
].join('\n')

export const args = command(
  'guard-release-pr',
  object({
    action: constant('guard-release-pr' as const),
    phase: option('--phase', choice(['start', 'finish'] as const, {metavar: 'PHASE'}), {
      description: message`start drafts the release PR and adds a caution notice; finish removes the notice (the PR stays a draft)`,
    }),
  }),
  {
    description: message`Mark the rolling release PR as regenerating (draft + caution notice)`,
  },
)

type GuardArgs = InferValue<typeof args>

// Pure body transforms; both idempotent. Exported for tests.
export function addCaution(body: string): string {
  if (body.startsWith(CAUTION_BLOCK)) return body
  return body ? `${CAUTION_BLOCK}\n\n${body}` : CAUTION_BLOCK
}

export function removeCaution(body: string): string {
  if (!body.startsWith(CAUTION_BLOCK)) return body
  return body.slice(CAUTION_BLOCK.length).replace(/^\n+/, '')
}

export async function run(opts: GuardArgs): Promise<void> {
  const {owner, repo} = repoSlug()

  const {data: prs} = await octokit().pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${RELEASE_BRANCH}`,
    base: 'main',
  })
  const pr = prs[0]
  if (!pr) {
    console.error(`No open release PR (head ${RELEASE_BRANCH}) — nothing to guard`)
    return
  }

  if (opts.phase === 'start' && !pr.draft) {
    // Draft conversion is only exposed via GraphQL.
    await octokit().graphql(
      `mutation($id: ID!) {
        convertPullRequestToDraft(input: {pullRequestId: $id}) {
          pullRequest { isDraft }
        }
      }`,
      {id: pr.node_id},
    )
  }

  const body = pr.body ?? ''
  const nextBody = opts.phase === 'start' ? addCaution(body) : removeCaution(body)
  if (nextBody !== body) {
    await octokit().pulls.update({owner, repo, pull_number: pr.number, body: nextBody})
  }

  console.error(`guard-release-pr ${opts.phase}: release PR #${pr.number}`)
}
