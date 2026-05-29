import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {loadEnvFiles, validateNvsKeys} from '../deploy.js'

describe('loadEnvFiles', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(pathlib.join(tmpdir(), 'loadEnv-'))
  })

  afterEach(() => {
    rmSync(cwd, {recursive: true, force: true})
  })

  it('returns empty when nothing exists', async () => {
    expect(await loadEnvFiles({cwd, mode: 'development'})).to.deep.equal([])
  })

  it('marks .env entries as secret by default', async () => {
    writeFileSync(pathlib.join(cwd, '.env'), 'FOO=bar\n')
    expect(await loadEnvFiles({cwd, mode: 'development'})).to.deep.equal([
      {key: 'FOO', value: 'bar', secret: true},
    ])
  })

  it('honors @no-secret annotation in .env', async () => {
    writeFileSync(pathlib.join(cwd, '.env'), '# @no-secret\nFOO=bar\nBAZ=qux\n')
    expect(await loadEnvFiles({cwd, mode: 'development'})).to.deep.equal([
      {key: 'FOO', value: 'bar', secret: false},
      {key: 'BAZ', value: 'qux', secret: true},
    ])
  })

  it('layers .env.<mode> over .env (last wins)', async () => {
    writeFileSync(pathlib.join(cwd, '.env'), 'FOO=base\nSHARED=base\n')
    writeFileSync(pathlib.join(cwd, '.env.production'), 'FOO=prod\n')
    const vars = await loadEnvFiles({cwd, mode: 'production'})
    const byKey = Object.fromEntries(vars.map((v) => [v.key, v.value]))
    expect(byKey).to.deep.equal({FOO: 'prod', SHARED: 'base'})
  })

  it('explicit envFile layers over auto-discovered, marked secret by default', async () => {
    writeFileSync(pathlib.join(cwd, '.env'), 'FOO=base\n')
    const explicit = pathlib.join(cwd, 'override.env')
    writeFileSync(explicit, 'FOO=explicit\n')
    const vars = await loadEnvFiles({cwd, mode: 'development', envFile: explicit})
    expect(vars).to.deep.equal([{key: 'FOO', value: 'explicit', secret: true}])
  })

  it('skips auto-discovery when noAutoEnv is true', async () => {
    writeFileSync(pathlib.join(cwd, '.env'), 'FOO=bar\n')
    expect(await loadEnvFiles({cwd, mode: 'development', noAutoEnv: true})).to.deep.equal([])
  })

  it('still loads explicit envFile when noAutoEnv is true', async () => {
    writeFileSync(pathlib.join(cwd, '.env'), 'FOO=auto\n')
    const explicit = pathlib.join(cwd, 'explicit.env')
    writeFileSync(explicit, 'FOO=explicit\n')
    const vars = await loadEnvFiles({
      cwd,
      mode: 'development',
      envFile: explicit,
      noAutoEnv: true,
    })
    expect(vars).to.deep.equal([{key: 'FOO', value: 'explicit', secret: true}])
  })

  it('throws when explicit envFile is missing', async () => {
    await expect(
      loadEnvFiles({cwd, mode: 'development', envFile: pathlib.join(cwd, 'missing')}),
    ).rejects.toThrow(/Env file not found/)
  })

  it('does not throw when auto-discovered files are missing', async () => {
    expect(await loadEnvFiles({cwd, mode: 'production'})).to.deep.equal([])
  })
})

describe('validateNvsKeys', () => {
  it('passes when all keys are within the limit', () => {
    expect(() =>
      validateNvsKeys([
        {key: 'SHORT', value: 'x', secret: false},
        {key: 'EXACTLY15CHARS_', value: 'x', secret: false},
      ]),
    ).not.to.throw()
  })

  it('reports every overlong key in a single error', () => {
    expect(() =>
      validateNvsKeys([
        {key: 'OK', value: 'x', secret: false},
        {key: 'TOO_LONG_KEY_NAME', value: 'x', secret: false},
        {key: 'ANOTHER_VERY_LONG_KEY', value: 'x', secret: false},
      ]),
    ).to.throw(/TOO_LONG_KEY_NAME[\s\S]*ANOTHER_VERY_LONG_KEY/)
  })
})
