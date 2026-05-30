import {describe, expect, test} from 'vitest'

import type {EventPayload} from '../util/githubEvent.js'
import {decideReleasePure, isPreviewAlreadyPublished} from './plan.js'

const REPO = 'mikrojs/mikro'

function pr(
  overrides: Partial<NonNullable<EventPayload['pull_request']>> = {},
): EventPayload['pull_request'] {
  return {
    number: 42,
    state: 'open',
    head: {ref: 'feature/x', repo: {full_name: REPO}},
    base: {repo: {full_name: REPO}},
    labels: [],
    ...overrides,
  }
}

function payload(overrides: Partial<EventPayload> = {}): EventPayload {
  return {repository: {full_name: REPO}, ...overrides}
}

describe('decideReleasePure: workflow_dispatch', () => {
  test('mode=next', () => {
    const p = payload({inputs: {mode: 'next'}})
    expect(decideReleasePure('workflow_dispatch', p)).toMatchObject({
      mode: 'next',
      shouldRun: true,
      npmTag: 'next',
    })
  })

  test('mode=release', () => {
    const p = payload({inputs: {mode: 'release'}})
    expect(decideReleasePure('workflow_dispatch', p)).toMatchObject({
      mode: 'release',
      shouldRun: true,
      npmTag: 'latest',
    })
  })

  test('mode=canary', () => {
    const p = payload({inputs: {mode: 'canary'}})
    expect(decideReleasePure('workflow_dispatch', p)).toMatchObject({
      mode: 'canary',
      shouldRun: true,
      npmTag: 'canary',
    })
  })

  test('unknown mode skips', () => {
    const p = payload({inputs: {mode: 'bogus'}})
    expect(decideReleasePure('workflow_dispatch', p)).toMatchObject({
      mode: 'skip',
      shouldRun: false,
    })
  })
})

describe('decideReleasePure: pr-preview', () => {
  test('labeled with release:preview → pr-preview', () => {
    const p = payload({
      action: 'labeled',
      label: {name: 'release:preview'},
      pull_request: pr({labels: [{name: 'release:preview'}]}),
    })
    expect(decideReleasePure('pull_request', p)).toMatchObject({
      mode: 'pr-preview',
      shouldRun: true,
      npmTag: 'pr-42',
      pr: 42,
    })
  })

  test('labeled on the release PR → release-preview (next tag)', () => {
    const p = payload({
      action: 'labeled',
      label: {name: 'release:preview'},
      pull_request: pr({
        head: {ref: 'ci/release-main', repo: {full_name: REPO}},
        labels: [{name: 'release:preview'}],
      }),
    })
    expect(decideReleasePure('pull_request', p)).toMatchObject({
      mode: 'release-preview',
      shouldRun: true,
      npmTag: 'next',
      pr: 42,
    })
  })

  test('labeled with a different label is skipped', () => {
    const p = payload({
      action: 'labeled',
      label: {name: 'good-first-issue'},
      pull_request: pr({labels: [{name: 'good-first-issue'}]}),
    })
    expect(decideReleasePure('pull_request', p).mode).toBe('skip')
  })

  test('synchronize on a labeled PR is skipped (one-shot)', () => {
    // Even if the label is still present after a previous publish/un-label race,
    // synchronize must not re-publish.
    const p = payload({
      action: 'synchronize',
      pull_request: pr({labels: [{name: 'release:preview'}]}),
    })
    expect(decideReleasePure('pull_request', p).mode).toBe('skip')
  })

  test('labeled but PR is closed is skipped', () => {
    const p = payload({
      action: 'labeled',
      label: {name: 'release:preview'},
      pull_request: pr({state: 'closed', labels: [{name: 'release:preview'}]}),
    })
    expect(decideReleasePure('pull_request', p).mode).toBe('skip')
  })
})

describe('decideReleasePure: fork PR safety', () => {
  test('fork PR is skipped regardless of label', () => {
    const p = payload({
      action: 'labeled',
      label: {name: 'release:preview'},
      pull_request: pr({
        head: {ref: 'feature/x', repo: {full_name: 'attacker/mikrojs'}},
        base: {repo: {full_name: REPO}},
        labels: [{name: 'release:preview'}],
      }),
    })
    expect(decideReleasePure('pull_request', p)).toMatchObject({
      mode: 'skip',
      reason: expect.stringContaining('fork PR'),
    })
  })
})

describe('decideReleasePure: misc', () => {
  test('unsupported event type is skipped', () => {
    expect(decideReleasePure('issue_comment', payload()).mode).toBe('skip')
    expect(decideReleasePure(undefined, payload()).mode).toBe('skip')
  })
})

describe('isPreviewAlreadyPublished', () => {
  const NAMES = ['mikro', '@mikrojs/native']
  const V = '0.10.0-next.7.gabc1234'

  test('preview re-run with every package already on the registry → true (skip)', () => {
    expect(isPreviewAlreadyPublished('release-preview', V, NAMES, () => true)).toBe(true)
    expect(isPreviewAlreadyPublished('pr-preview', V, NAMES, () => true)).toBe(true)
  })

  test('partial publish (one package missing) → false (must run to finish the rest)', () => {
    const published = new Set([`mikro@${V}`])
    expect(
      isPreviewAlreadyPublished('release-preview', V, NAMES, (n, v) => published.has(`${n}@${v}`)),
    ).toBe(false)
  })

  test('non-preview modes never short-circuit, even if all published', () => {
    for (const mode of ['release', 'next', 'canary', 'create-release-pr', 'skip'] as const) {
      expect(isPreviewAlreadyPublished(mode, V, NAMES, () => true)).toBe(false)
    }
  })

  test('null version or no packages → false (nothing to compare)', () => {
    expect(isPreviewAlreadyPublished('pr-preview', null, NAMES, () => true)).toBe(false)
    expect(isPreviewAlreadyPublished('pr-preview', V, [], () => true)).toBe(false)
  })
})
