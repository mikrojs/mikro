import {describe, expect, test} from 'vitest'

import type {EventPayload} from '../util/githubEvent.js'
import {decideReleasePure} from './plan.js'

const REPO = 'mikrojs/mikrojs'

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

describe('decideReleasePure: pull_request release-PR merge', () => {
  test('PR closed + merged + head=ci/release-main → release', () => {
    const p = payload({
      action: 'closed',
      pull_request: pr({merged: true, head: {ref: 'ci/release-main', repo: {full_name: REPO}}}),
    })
    expect(decideReleasePure('pull_request', p)).toMatchObject({
      mode: 'release',
      shouldRun: true,
      npmTag: 'latest',
      pr: 42,
    })
  })

  test('PR closed but NOT merged is skipped (closed without merge)', () => {
    const p = payload({
      action: 'closed',
      pull_request: pr({merged: false, head: {ref: 'ci/release-main', repo: {full_name: REPO}}}),
    })
    expect(decideReleasePure('pull_request', p).mode).toBe('skip')
  })

  test('PR closed + merged but head ≠ ci/release-main is skipped', () => {
    const p = payload({
      action: 'closed',
      pull_request: pr({merged: true, head: {ref: 'feature/x', repo: {full_name: REPO}}}),
    })
    expect(decideReleasePure('pull_request', p).mode).toBe('skip')
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

  test('fork PR closed + merged + head=ci/release-main is still skipped', () => {
    // Defensive: even if a fork could somehow have a head ref of ci/release-main,
    // we never trust merge-from-fork.
    const p = payload({
      action: 'closed',
      pull_request: pr({
        merged: true,
        head: {ref: 'ci/release-main', repo: {full_name: 'attacker/mikrojs'}},
        base: {repo: {full_name: REPO}},
      }),
    })
    // Pin the reason: "skip" is the right outcome, but it must be for the
    // fork-PR check (which runs first), not because the head/merge match
    // failed. Catches a hypothetical reorder of the checks.
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
