import {describe, expect, it} from 'vitest'

import {formatDuplicatePackagesNotice} from '../duplicatePackages.js'

describe('formatDuplicatePackagesNotice', () => {
  it('returns undefined when there are no duplicates', () => {
    expect(formatDuplicatePackagesNotice([])).toBeUndefined()
  })

  it('names the package and lists each copy with its version', () => {
    const notice = formatDuplicatePackagesNotice([
      {
        name: 'c',
        copies: [
          {path: 'app/node_modules/a/node_modules/c', version: '1.2.0'},
          {path: 'app/node_modules/b/node_modules/c', version: '2.0.1'},
        ],
      },
    ])

    expect(notice).toBe(
      [
        'This app deploys 2 copies of c. The device loads each copy as a separate module:',
        '  app/node_modules/a/node_modules/c (1.2.0)',
        '  app/node_modules/b/node_modules/c (2.0.1)',
      ].join('\n'),
    )
  })

  it('leaves out a version it does not have', () => {
    const notice = formatDuplicatePackagesNotice([
      {
        name: 'c',
        copies: [{path: 'node_modules/c', version: '1.2.0'}, {path: 'lib/node_modules/c'}],
      },
    ])

    expect(notice).toContain('\n  lib/node_modules/c')
    expect(notice).not.toContain('undefined')
  })

  it('stays one notice for several packages', () => {
    const notice = formatDuplicatePackagesNotice([
      {name: 'c', copies: [{path: 'node_modules/a/node_modules/c'}, {path: 'node_modules/c'}]},
      {
        name: '@scope/d',
        copies: [{path: 'node_modules/@scope/d'}, {path: 'node_modules/a/node_modules/@scope/d'}],
      },
    ])

    expect(notice).toBe(
      [
        'This app deploys more than one copy of 2 packages. The device loads each copy as a separate module:',
        '  node_modules/a/node_modules/c',
        '  node_modules/c',
        '  node_modules/@scope/d',
        '  node_modules/a/node_modules/@scope/d',
      ].join('\n'),
    )
  })
})
