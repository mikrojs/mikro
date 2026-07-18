/* eslint-disable no-console */
import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {choice} from '@optique/core/valueparser'

import {findReleaseBase, getCommitsSince} from '../util/commits.js'
import {PREVIEW_LABEL, RELEASE_BRANCH} from '../util/constants.js'
import {readGitInfo} from '../util/git.js'
import {type EventPayload, hasLabel, isSameRepoPr, readGitHubEvent} from '../util/githubEvent.js'
import {octokit, repoSlug} from '../util/octokit.js'
import {recommendBump} from '../util/version.js'
import {readCanonicalVersion} from '../util/workspace.js'
import {computeBumpPure} from './bump.js'

export type Mode =
  | 'release'
  | 'release-preview'
  | 'canary'
  | 'pr-preview'
  | 'create-release-pr'
  | 'skip'

export interface Plan {
  mode: Mode
  shouldRun: boolean
  npmTag: string | null
  pr: number | null
  reason: string
  version: string | null
}

export const args = command(
  'plan',
  object({
    action: constant('plan' as const),
    context: option(
      '--context',
      choice(['release', 'create-release-pr'] as const, {metavar: 'CONTEXT'}),
      {description: message`Which workflow is asking (default: release)`},
    ),
    json: optional(
      flag('--json', {description: message`Emit Plan JSON instead of GitHub Actions outputs`}),
    ),
  }),
  {description: message`Decide release mode from GitHub Actions event context`},
)

type PlanArgs = InferValue<typeof args>

const SKIP = (reason: string, pr: number | null = null): Plan => ({
  mode: 'skip',
  shouldRun: false,
  npmTag: null,
  pr,
  reason,
  version: null,
})

// Pure: given an event name + payload, return the plan.
// Exported for tests.
export function decideReleasePure(eventName: string | undefined, payload: EventPayload): Plan {
  if (eventName === 'workflow_dispatch') {
    const mode = payload.inputs?.mode as Mode | undefined
    if (mode === 'release' || mode === 'canary') {
      return {
        mode,
        shouldRun: true,
        npmTag: mode === 'release' ? 'latest' : mode,
        pr: null,
        reason: `workflow_dispatch mode=${mode}`,
        version: null,
      }
    }
    return SKIP(`workflow_dispatch with unknown mode: ${mode ?? '<none>'}`)
  }

  if (eventName === 'pull_request') {
    const pr = payload.pull_request
    if (!pr) return SKIP('pull_request event without payload')

    if (!isSameRepoPr(payload)) {
      return SKIP('fork PR — releases disabled', pr.number)
    }

    // One-shot: only `labeled` (with the matching label) triggers a preview
    // publish. The label is removed after publish, so the next preview
    // requires re-labeling.
    if (
      payload.action === 'labeled' &&
      payload.label?.name === PREVIEW_LABEL &&
      hasLabel(payload, PREVIEW_LABEL)
    ) {
      if (pr.state !== 'open') return SKIP('PR not open', pr.number)
      // On the rolling release PR, a preview publishes the pending release
      // under the `next` dist-tag — a dry run of the release about to ship.
      // On any other PR it's a per-PR `pr-<N>` preview.
      if (pr.head?.ref === RELEASE_BRANCH) {
        return {
          mode: 'release-preview',
          shouldRun: true,
          npmTag: 'next',
          pr: pr.number,
          reason: `${PREVIEW_LABEL} label added on release PR ${pr.number} → next`,
          version: null,
        }
      }
      return {
        mode: 'pr-preview',
        shouldRun: true,
        npmTag: `pr-${pr.number}`,
        pr: pr.number,
        reason: `${PREVIEW_LABEL} label added on PR ${pr.number}`,
        version: null,
      }
    }

    return SKIP(`pull_request action=${payload.action} did not match`, pr.number)
  }

  return SKIP(`unsupported event: ${eventName ?? '<none>'}`)
}

// Find a release PR that the given commit is the merge of. Errors propagate
// — a transient API failure is real signal that something's wrong, not
// something to paper over.
async function findAssociatedReleasePr(sha: string): Promise<{number: number} | null> {
  const {owner, repo} = repoSlug()
  const {data} = await octokit().repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
  })
  return data.find((p) => p.head?.ref === RELEASE_BRANCH) ?? null
}

// For release.yml on `push`: only run when the head commit is the merge of a
// release PR. The push trigger (vs. pull_request: closed) is what makes the
// resulting status check appear on main's commit instead of the closed PR.
async function decidePushReleaseMerge(): Promise<Plan> {
  const sha = process.env.GITHUB_SHA
  if (!sha) return SKIP('GITHUB_SHA not set')
  const releasePr = await findAssociatedReleasePr(sha)
  if (!releasePr) return SKIP(`push ${sha.slice(0, 7)} is not a release-PR merge`)
  return {
    mode: 'release',
    shouldRun: true,
    npmTag: 'latest',
    pr: releasePr.number,
    reason: `push ${sha.slice(0, 7)} is merge of release PR #${releasePr.number}`,
    version: null,
  }
}

// For create-release-pr.yml: skip when the push is the merge commit of a
// release PR, or when nothing landed since the last release (bump would
// fall back to patch and produce an empty-changelog PR). Manual
// workflow_dispatch skips only the release-PR-merge check, since it has no
// triggering commit.
async function decideCreateReleasePr(): Promise<Plan> {
  const {eventName} = readGitHubEvent()
  if (eventName !== 'push' && eventName !== 'workflow_dispatch') {
    return SKIP(
      `create-release-pr context expects push or workflow_dispatch event, got ${eventName ?? '<none>'}`,
    )
  }
  if (eventName === 'push') {
    const sha = process.env.GITHUB_SHA
    if (!sha) return SKIP('GITHUB_SHA not set')
    const releasePr = await findAssociatedReleasePr(sha)
    if (releasePr) {
      return SKIP(`push is merge of release PR #${releasePr.number}`, releasePr.number)
    }
  }
  if (getCommitsSince(findReleaseBase()).length === 0) {
    return SKIP('no commits since the last release')
  }
  return {
    mode: 'create-release-pr',
    shouldRun: true,
    npmTag: null,
    pr: null,
    reason: eventName === 'workflow_dispatch' ? 'workflow_dispatch' : 'regular push to main',
    version: null,
  }
}

// Compute the version a downstream job will publish. Computed once in the
// plan job so all downstream jobs (firmware, prebuilds, publish) write
// the exact same string — critical for pr-preview where the timestamp
// would otherwise drift between runs.
async function computePlannedVersion(plan: Plan): Promise<string | null> {
  if (!plan.shouldRun) return null
  if (
    plan.mode !== 'release' &&
    plan.mode !== 'release-preview' &&
    plan.mode !== 'canary' &&
    plan.mode !== 'pr-preview'
  ) {
    return null
  }
  const result = computeBumpPure({
    mode: plan.mode,
    pr: plan.pr ?? undefined,
    // For release mode the canonical version IS the publish version (the
    // release PR has already bumped). For other modes, append a suffix.
    useCurrent: plan.mode === 'release',
    // Match what create-release-pr.yml does: cap pre-major bumps so a
    // `feat!:` on 0.x produces a 0.x.0 preview, not 1.0.0. Without this
    // a PR preview would publish as 1.0.0-pr-N.* even though the eventual
    // release will be 0.x.0.
    breakingIsMinorOn0x: true,
    currentVersion: readCanonicalVersion(),
    semverIncrement: recommendBump(getCommitsSince(findReleaseBase())),
    git: readGitInfo(),
    now: new Date(),
  })
  return result.version
}

export async function run(opts: PlanArgs): Promise<void> {
  let plan: Plan
  if (opts.context === 'create-release-pr') {
    plan = await decideCreateReleasePr()
  } else {
    const {eventName, payload} = readGitHubEvent()
    if (eventName === 'push') {
      plan = await decidePushReleaseMerge()
    } else {
      plan = decideReleasePure(eventName, payload)
    }
  }

  plan.version = await computePlannedVersion(plan)

  if (opts.json) {
    console.log(JSON.stringify(plan))
    return
  }

  // GitHub Actions outputs format. Empty string for null is intentional
  // and load-bearing: downstream YAML uses `${{ ...pr && format('--pr {0}', ...pr) || '' }}`,
  // and an empty string is falsy in GHA expressions, which is what omits
  // the flag on non-PR triggers. Never emit '0' for null here.
  console.log(`mode=${plan.mode}`)
  console.log(`should_run=${plan.shouldRun}`)
  console.log(`npm_tag=${plan.npmTag ?? ''}`)
  console.log(`pr=${plan.pr ?? ''}`)
  console.log(`version=${plan.version ?? ''}`)
  console.log(`reason=${plan.reason}`)
}
