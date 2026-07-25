import {homedir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'vitest'

import {displayPath} from '../displayPath.js'

describe('displayPath', () => {
  it('shows a path under the working directory relative to it', () => {
    expect(displayPath(join(process.cwd(), '.mikro', 'ota-push.tgz'))).toBe(
      join('.mikro', 'ota-push.tgz'),
    )
  })

  it('shows a path outside the working directory but under home as ~/…', () => {
    // The CLI runs from wherever the user's project is, so a registry file in
    // ~/.mikro is normal and must not print as /Users/<name>/….
    expect(displayPath(join(homedir(), '.mikro', 'registry.json'))).toBe(
      join('~', '.mikro', 'registry.json'),
    )
  })

  it('leaves a path under neither alone', () => {
    expect(displayPath('/opt/builds/app.tgz')).toBe('/opt/builds/app.tgz')
  })
})
