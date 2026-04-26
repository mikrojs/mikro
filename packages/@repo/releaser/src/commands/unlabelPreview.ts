/* eslint-disable no-console */
import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {integer} from '@optique/core/valueparser'

import {PREVIEW_LABEL} from '../util/constants.js'
import {octokit, repoSlug} from '../util/octokit.js'

export const args = command(
  'unlabel-preview',
  object({
    action: constant('unlabel-preview' as const),
    pr: option('--pr', integer({metavar: 'N'}), {description: message`Pull request number`}),
  }),
  {
    description: message`Remove the ${PREVIEW_LABEL} label from a PR (one-shot preview semantics)`,
  },
)

type UnlabelArgs = InferValue<typeof args>

export async function run(opts: UnlabelArgs): Promise<void> {
  const {owner, repo} = repoSlug()
  try {
    await octokit().issues.removeLabel({
      owner,
      repo,
      issue_number: opts.pr,
      name: PREVIEW_LABEL,
    })
    console.error(`Removed '${PREVIEW_LABEL}' from PR #${opts.pr}`)
  } catch (err) {
    // 404 means the label was already removed (e.g. user removed it manually).
    // Not an error — log and continue.
    const status = (err as {status?: number}).status
    if (status === 404) {
      console.error(`Label '${PREVIEW_LABEL}' not present on PR #${opts.pr} — nothing to do`)
      return
    }
    throw err
  }
}
