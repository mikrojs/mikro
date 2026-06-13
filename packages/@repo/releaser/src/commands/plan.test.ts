import {describe, expect, test} from 'vitest'

import type {EventPayload} from '../util/githubEvent.js'
import {decideReleasePure} from './plan.js'

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
  test('mode=next is no longer dispatchable (next ships via the release-PR label)', () => {
    const p = payload({inputs: {mode: 'next'}})
    expect(decideReleasePure('workflow_dispatch', p)).toMatchObject({
      mode: 'skip',
      shouldRun: false,
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
