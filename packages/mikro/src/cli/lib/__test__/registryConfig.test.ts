import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  requireRegistryToken,
  requireRegistryUrl,
  resolveRegistryConnection,
} from '../registryConfig.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'registry-config-'))
})

afterEach(() => {
  rmSync(dir, {recursive: true, force: true})
})

function files(project?: object, user?: object) {
  const projectFile = join(dir, 'project.json')
  const userFile = join(dir, 'user.json')
  if (project) writeFileSync(projectFile, JSON.stringify(project))
  if (user) writeFileSync(userFile, JSON.stringify(user))
  return {projectFile, userFile, env: {} as NodeJS.ProcessEnv}
}

describe('resolveRegistryConnection', () => {
  it('resolves nothing when no source has values', () => {
    expect(resolveRegistryConnection({}, files())).toEqual({})
  })

  it('reads the project file, falling back to the user file for the url', () => {
    const overrides = files({}, {url: 'https://user.test', token: 'user-token'})
    expect(resolveRegistryConnection({}, overrides)).toEqual({
      url: 'https://user.test',
      token: 'user-token',
    })
  })

  it('adopts a user-file token when the project names the same registry', () => {
    const overrides = files(
      {url: 'https://same.test/'},
      {url: 'https://same.test', token: 'user-token'},
    )
    expect(resolveRegistryConnection({}, overrides)).toEqual({
      url: 'https://same.test/',
      token: 'user-token',
    })
  })

  it('never sends a stored token to a registry it was not stored against', () => {
    const overrides = files(
      {url: 'http://localhost:8787'},
      {url: 'https://registry.acme.com', token: 'prod-token'},
    )
    expect(resolveRegistryConnection({}, overrides)).toEqual({url: 'http://localhost:8787'})
  })

  it('does not attach a stored token to an arbitrary --registry', () => {
    const overrides = files({}, {url: 'https://registry.acme.com', token: 'prod-token'})
    expect(resolveRegistryConnection({registry: 'https://anything.example'}, overrides)).toEqual({
      url: 'https://anything.example',
    })
  })

  it('lets --token and the env var cross registries, since both are explicit', () => {
    const overrides = files({}, {url: 'https://registry.acme.com', token: 'prod-token'})
    expect(
      resolveRegistryConnection({registry: 'https://other.test', token: 'flag-token'}, overrides)
        .token,
    ).toBe('flag-token')

    const envOverrides = files({}, {url: 'https://registry.acme.com', token: 'prod-token'})
    envOverrides.env.MIKRO_OTA_TOKEN = 'env-token'
    expect(resolveRegistryConnection({registry: 'https://other.test'}, envOverrides).token).toBe(
      'env-token',
    )
  })

  it('treats registries under different paths on one host as distinct', () => {
    const overrides = files(
      {url: 'https://host.test/staging'},
      {url: 'https://host.test/prod', token: 'prod-token'},
    )
    expect(resolveRegistryConnection({}, overrides)).toEqual({url: 'https://host.test/staging'})
  })

  it('flags win over everything', () => {
    const overrides = files({url: 'https://project.test', token: 'project-token'})
    overrides.env.MIKRO_OTA_TOKEN = 'env-token'
    expect(
      resolveRegistryConnection({registry: 'https://flag.test', token: 'flag-token'}, overrides),
    ).toEqual({
      url: 'https://flag.test',
      token: 'flag-token',
    })
  })

  it('the token env var beats the files but not the flag', () => {
    const overrides = files({token: 'project-token'})
    overrides.env.MIKRO_OTA_TOKEN = 'env-token'
    expect(resolveRegistryConnection({}, overrides).token).toBe('env-token')
  })

  it('ignores empty and non-string fields', () => {
    const overrides = files({url: '', token: 42})
    expect(resolveRegistryConnection({}, overrides)).toEqual({})
  })

  it('throws on malformed JSON instead of silently ignoring it', () => {
    const projectFile = join(dir, 'broken.json')
    writeFileSync(projectFile, '{not json')
    expect(() =>
      resolveRegistryConnection({}, {projectFile, userFile: join(dir, 'missing.json'), env: {}}),
    ).toThrow(/not valid JSON/)
  })
})

describe('requireRegistryUrl / requireRegistryToken', () => {
  it('returns present values and errors with pointed guidance otherwise', () => {
    expect(requireRegistryUrl({url: 'https://r.test'})).toBe('https://r.test')
    expect(requireRegistryToken({token: 't'})).toBe('t')
    expect(() => requireRegistryUrl({})).toThrow(/mikro ota setup/)
    expect(() => requireRegistryToken({})).toThrow(/MIKRO_OTA_TOKEN/)
  })
})
