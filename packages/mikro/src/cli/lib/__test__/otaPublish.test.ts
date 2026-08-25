import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'

import {writeFile} from 'fs/promises'
import {join} from 'path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import type {OtaManifest} from '../ota.js'
import {
  buildReleaseRequest,
  buildUploadRequest,
  type FetchLike,
  joinUrl,
  publishBuild,
  type PublishInput,
  releaseBuild,
} from '../otaPublish.js'

const manifest: OtaManifest = {
  app: 'my-app',
  version: '1.2.0',
  firmwareVersion: '0.15.0',
  bytecodeVersion: 13,
}

const input: PublishInput = {
  registry: 'https://updates.example.com/',
  checksum: 'abc123',
  size: 4096,
  manifest,
}

/** A build packed from a repository: every source field rides in the manifest,
 *  so a `--tarball` push reports the same ones. */
const withSource: PublishInput = {
  ...input,
  manifest: {
    ...manifest,
    repository: 'https://github.com/acme/sensor',
    directory: 'examples/sensor',
    commit: 'a1b2c3d4e5f6',
    dirty: true,
  },
}

describe('joinUrl', () => {
  it('joins tolerating trailing/leading slashes', () => {
    expect(joinUrl('https://r.example.com', 'builds')).toBe('https://r.example.com/builds')
    expect(joinUrl('https://r.example.com/', '/builds')).toBe('https://r.example.com/builds')
  })
})

describe('buildUploadRequest', () => {
  it('targets /builds with bearer auth and metadata fields', () => {
    const req = buildUploadRequest(input, 'secret-key')
    expect(req.url).toBe('https://updates.example.com/api/v1/builds')
    expect(req.method).toBe('POST')
    expect(req.headers.authorization).toBe('Bearer secret-key')
    expect(req.fields).toEqual({
      app: 'my-app',
      version: '1.2.0',
      checksum: 'abc123',
      size: '4096',
      firmwareVersion: '0.15.0',
      bytecodeVersion: '13',
    })
  })

  it('carries a note when one is given', () => {
    const req = buildUploadRequest({...input, note: 'fixed the sensor read'}, 'secret-key')
    expect(req.fields.note).toBe('fixed the sensor read')
  })

  it('sends create as a truthy flag field only when set', () => {
    expect(buildUploadRequest(input, 'k').fields.create).toBeUndefined()
    expect(buildUploadRequest({...input, create: true}, 'k').fields.create).toBe('1')
  })

  // Absent channel = the build is stored but served to nobody.
  it('carries a channel only when set', () => {
    expect(buildUploadRequest(input, 'k').fields.channel).toBeUndefined()
    expect(buildUploadRequest({...input, channel: 'beta'}, 'k').fields.channel).toBe('beta')
  })

  // Source fields ride on the manifest, so they are present whenever the build was
  // packed from a repo/commit and omitted otherwise.
  it('omits source fields when there are none', () => {
    const {repository, directory, commit, dirty} = buildUploadRequest(input, 'k').fields
    expect(repository).toBeUndefined()
    expect(directory).toBeUndefined()
    expect(commit).toBeUndefined()
    expect(dirty).toBeUndefined()
  })

  // Every source field comes off the manifest, so a `--tarball` push (which has
  // nothing but the artifact) sends exactly what the pack recorded.
  it('carries repository, directory, and commit from the manifest, dirty as a flag', () => {
    const {fields} = buildUploadRequest(withSource, 'k')
    expect(fields.repository).toBe('https://github.com/acme/sensor')
    expect(fields.directory).toBe('examples/sensor')
    expect(fields.commit).toBe('a1b2c3d4e5f6')
    expect(fields.dirty).toBe('1')
  })

  it('serializes the manifest config schema as a JSON field, omitted when absent', () => {
    const schema = {kind: 'object', shape: {interval: {kind: 'number', default: 60}}}
    const req = buildUploadRequest(
      {...input, manifest: {...manifest, configSchema: schema}},
      'secret-key',
    )
    expect(req.fields.configSchema).toBe(JSON.stringify(schema))
    expect(buildUploadRequest(input, 'secret-key').fields.configSchema).toBeUndefined()
  })

  it('omits the dirty flag for a clean tree even with a commit', () => {
    const clean: PublishInput = {...input, manifest: {...manifest, commit: 'a1b2c3d4e5f6'}}
    const {fields} = buildUploadRequest(clean, 'k')
    expect(fields.commit).toBe('a1b2c3d4e5f6')
    expect(fields.dirty).toBeUndefined()
  })
})

describe('publishBuild', () => {
  let dir = ''
  let buildPath = ''

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ota-pub-'))
    buildPath = join(dir, 'app-0.0.0.tgz')
    await writeFile(buildPath, Buffer.from([1, 2, 3, 4]))
  })

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  it('surfaces the registry advisory warnings, empty when the body has none', async () => {
    const withWarnings: FetchLike = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({ok: true, warnings: ['note: default of .interval changed']}),
    })
    const first = await publishBuild(input, buildPath, 'k', withWarnings)
    expect(first.warnings).toEqual(['note: default of .interval changed'])

    const bare: FetchLike = async () => ({ok: true, status: 200, text: async () => ''})
    const second = await publishBuild(input, buildPath, 'k', bare)
    expect(second.warnings).toEqual([])
  })

  it('uploads the build with bearer auth and metadata', async () => {
    const calls: {url: string; init: RequestInit}[] = []
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      calls.push({url, init})
      return {ok: true, status: 200, text: async () => ''}
    })

    await publishBuild(input, buildPath, 'secret-key', fetchImpl)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://updates.example.com/api/v1/builds')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-key',
    )
    expect(calls[0]!.init.body).toBeInstanceOf(FormData)
    const form = calls[0]!.init.body as FormData
    expect(form.get('app')).toBe('my-app')
    expect(form.get('checksum')).toBe('abc123')
    expect(form.get('firmwareVersion')).toBe('0.15.0')
    expect(form.get('build')).toBeInstanceOf(Blob)
    // No --note given, so the field is omitted entirely.
    expect(form.get('note')).toBeNull()
  })

  it('includes the note field when provided', async () => {
    const calls: {url: string; init: RequestInit}[] = []
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      calls.push({url, init})
      return {ok: true, status: 200, text: async () => ''}
    })

    await publishBuild(
      {...input, note: 'fixed the sensor read'},
      buildPath,
      'secret-key',
      fetchImpl,
    )

    const form = calls[0]!.init.body as FormData
    expect(form.get('note')).toBe('fixed the sensor read')
  })

  // A push without --release stores the build but must not serve it, so the
  // channel field only reaches the wire when set.
  it('includes the channel field only when set', async () => {
    const stored: {calls: {url: string; init: RequestInit}[]; fetchImpl: FetchLike} = {
      calls: [],
      fetchImpl: vi.fn(async (url, init) => {
        stored.calls.push({url, init})
        return {ok: true, status: 200, text: async () => ''}
      }),
    }

    await publishBuild(input, buildPath, 'secret-key', stored.fetchImpl)
    expect((stored.calls[0]!.init.body as FormData).get('channel')).toBeNull()

    await publishBuild({...input, channel: 'beta'}, buildPath, 'secret-key', stored.fetchImpl)
    expect((stored.calls[1]!.init.body as FormData).get('channel')).toBe('beta')
  })

  it('sends source fields from the manifest', async () => {
    const calls: {url: string; init: RequestInit}[] = []
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      calls.push({url, init})
      return {ok: true, status: 200, text: async () => ''}
    })

    await publishBuild(withSource, buildPath, 'secret-key', fetchImpl)

    const form = calls[0]!.init.body as FormData
    expect(form.get('repository')).toBe('https://github.com/acme/sensor')
    expect(form.get('directory')).toBe('examples/sensor')
    expect(form.get('commit')).toBe('a1b2c3d4e5f6')
    expect(form.get('dirty')).toBe('1')
  })

  it('throws with the registry status and body on failure', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }))
    await expect(publishBuild(input, buildPath, 'bad-key', fetchImpl)).rejects.toThrow(
      /401.*unauthorized/,
    )
  })
})

const releaseInput = {
  registry: 'https://updates.example.com/',
  app: 'my-app',
  version: '1.2.0',
  channel: 'beta',
}

describe('buildReleaseRequest', () => {
  it('targets /releases with bearer auth and a JSON body', () => {
    const plan = buildReleaseRequest(releaseInput, 'secret-key')
    expect(plan.url).toBe('https://updates.example.com/api/v1/releases')
    expect(plan.method).toBe('POST')
    expect(plan.headers.authorization).toBe('Bearer secret-key')
    expect(plan.headers['content-type']).toBe('application/json')
    expect(JSON.parse(plan.body)).toEqual({app: 'my-app', version: '1.2.0', channel: 'beta'})
  })
})

describe('releaseBuild', () => {
  it('returns the released count on success', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ok: true, released: 4}),
    }))
    expect(await releaseBuild(releaseInput, 't', fetchImpl)).toEqual({released: 4, warnings: []})
  })

  it('defaults released to 0 when the response omits it', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ok: true}),
    }))
    expect(await releaseBuild(releaseInput, 't', fetchImpl)).toEqual({released: 0, warnings: []})
  })

  it('throws with the registry status and body on failure', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'no such build',
    }))
    await expect(releaseBuild(releaseInput, 't', fetchImpl)).rejects.toThrow(/404.*no such build/)
  })
})
