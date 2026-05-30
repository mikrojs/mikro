import {describe, expect, test} from 'vitest'

import type {PnpmPackage} from '../util/workspace.js'
import {selectPackagesToPublish} from './publish.js'

function pkg(name: string, version = '0.10.0-next.7.gabc1234'): PnpmPackage {
  return {name, version, path: `/repo/${name}`, private: false}
}

const PKGS = [pkg('mikro'), pkg('@mikrojs/native')]

describe('selectPackagesToPublish', () => {
  test('without --skip-existing returns all packages, never calls the predicate', () => {
    let calls = 0
    const result = selectPackagesToPublish(PKGS, false, () => {
      calls++
      return true
    })
    expect(result).toEqual(PKGS)
    expect(calls).toBe(0)
  })

  test('--skip-existing drops packages already on the registry', () => {
    const published = new Set(['mikro@0.10.0-next.7.gabc1234'])
    const result = selectPackagesToPublish(PKGS, true, (name, version) =>
      published.has(`${name}@${version}`),
    )
    expect(result.map((p) => p.name)).toEqual(['@mikrojs/native'])
  })

  test('--skip-existing returns empty when every package is already published (re-add no-op)', () => {
    // The sharp edge: label re-added with no new commits → identical version
    // → all packages already exist. Selection is empty; run() exits 0.
    const result = selectPackagesToPublish(PKGS, true, () => true)
    expect(result).toEqual([])
  })

  test('--skip-existing keeps all when none are published yet', () => {
    const result = selectPackagesToPublish(PKGS, true, () => false)
    expect(result).toEqual(PKGS)
  })
})
