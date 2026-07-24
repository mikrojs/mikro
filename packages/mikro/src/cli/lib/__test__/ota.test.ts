import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtempSync, rmSync, utimesSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {promisify} from 'node:util'

import {mkdir, readdir, readFile, writeFile} from 'fs/promises'
import {join} from 'path'
import semver from 'semver'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  createTarball,
  finalizeBuild,
  type GitSnapshotState,
  MANIFEST_NAME,
  normalizeRepositoryDirectory,
  normalizeRepositoryUrl,
  pruneMacSidecars,
  readBytecodeVersion,
  readManifestFromTarball,
  sha256File,
  snapshotVersion,
  writeManifest,
} from '../ota.js'

const execFileAsync = promisify(execFile)

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ota-test-'))
})

afterEach(() => {
  rmSync(dir, {recursive: true, force: true})
})

describe('readBytecodeVersion', () => {
  it('returns byte 0 of the first .bjs found', async () => {
    const appDir = join(dir, 'app')
    await mkdir(appDir, {recursive: true})
    await writeFile(join(appDir, 'main.bjs'), Buffer.from([0x0d, 0x01, 0x02]))
    expect(await readBytecodeVersion(dir)).toBe(0x0d)
  })

  it('throws when no .bjs exists', async () => {
    await writeFile(join(dir, 'main.js'), 'x')
    await expect(readBytecodeVersion(dir)).rejects.toThrow(/No \.bjs/)
  })

  it('ignores .bjson files', async () => {
    await writeFile(join(dir, 'data.bjson'), Buffer.from([0xff]))
    await writeFile(join(dir, 'main.bjs'), Buffer.from([0x42]))
    expect(await readBytecodeVersion(dir)).toBe(0x42)
  })
})

describe('writeManifest', () => {
  it('writes mikro.app.json at the build root', async () => {
    await writeManifest(dir, {
      app: 'my-app',
      version: '1.2.0',
      firmwareVersion: '0.15.0',
      bytecodeVersion: 13,
    })
    const content = JSON.parse(await readFile(join(dir, MANIFEST_NAME), 'utf-8'))
    expect(content).toEqual({
      app: 'my-app',
      version: '1.2.0',
      firmwareVersion: '0.15.0',
      bytecodeVersion: 13,
    })
  })
})

describe('pruneMacSidecars', () => {
  it('removes ._* and .DS_Store recursively, keeps real files', async () => {
    const sub = join(dir, 'app')
    await mkdir(sub, {recursive: true})
    await writeFile(join(dir, '.DS_Store'), 'x')
    await writeFile(join(sub, '._main.bjs'), 'x')
    await writeFile(join(sub, 'main.bjs'), Buffer.from([1]))
    await pruneMacSidecars(dir)
    expect(await readdir(dir)).toEqual(['app'])
    expect(await readdir(sub)).toEqual(['main.bjs'])
  })
})

describe('sha256File', () => {
  it('matches a known SHA-256, lowercase hex', async () => {
    const file = join(dir, 'blob')
    const bytes = Buffer.from('mikro-ota', 'utf-8')
    await writeFile(file, bytes)
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(await sha256File(file)).toBe(expected)
    expect(await sha256File(file)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('createTarball + layout', () => {
  it('packs app/ tree plus manifest at root, excludes mac sidecars', async () => {
    const appDir = join(dir, 'app')
    await mkdir(appDir, {recursive: true})
    await writeFile(join(appDir, 'main.bjs'), Buffer.from([13]))
    await writeFile(join(appDir, 'package.json'), '{}')
    await writeFile(join(appDir, '.DS_Store'), 'junk')
    await writeManifest(dir, {
      app: 'my-app',
      version: '1.2.0',
      firmwareVersion: '0.15.0',
      bytecodeVersion: 13,
    })

    const out = join(tmpdir(), `ota-out-${Date.now()}.tgz`)
    try {
      await createTarball(dir, out)
      const {stdout} = await execFileAsync('tar', ['-tzf', out])
      const members = stdout.split('\n').filter(Boolean).sort()
      expect(members).toContain('mikro.app.json')
      expect(members).toContain('app/main.bjs')
      expect(members).toContain('app/package.json')
      expect(members.some((m) => m.includes('.DS_Store'))).toBe(false)
      expect(members.some((m) => m.includes('._'))).toBe(false)
    } finally {
      rmSync(out, {force: true})
    }
  })

  // The build checksum is a SHA-256 over this file, so an archive that varies
  // with when or where it was packed makes the checksum identify the archive
  // rather than the build: publish stops being idempotent, dedupe cannot work,
  // and a laptop and CI never agree on a hash for the same commit. Timestamps
  // are the loudest source (member mtimes and the gzip header's own), so the
  // gap and the touch are the point of the test, not incidental.
  it('produces a byte-identical archive from identical input', async () => {
    const appDir = join(dir, 'app', 'nested')
    await mkdir(appDir, {recursive: true})
    await writeFile(join(dir, 'app', 'main.js'), 'main')
    await writeFile(join(appDir, 'z.js'), 'z')
    await writeFile(join(appDir, 'a.js'), 'a')

    const first = join(tmpdir(), `ota-det-a-${Date.now()}.tgz`)
    const second = join(tmpdir(), `ota-det-b-${Date.now()}.tgz`)
    try {
      await createTarball(dir, first)
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const now = new Date()
      utimesSync(join(dir, 'app', 'main.js'), now, now)
      await createTarball(dir, second)

      expect(await sha256File(second)).toBe(await sha256File(first))
    } finally {
      rmSync(first, {force: true})
      rmSync(second, {force: true})
    }
  })

  // Order is part of that reproducibility, and readdir order is not stable
  // across filesystems, so it has to be imposed rather than inherited.
  it('orders members by path, each directory before its contents', async () => {
    const appDir = join(dir, 'app', 'nested')
    await mkdir(appDir, {recursive: true})
    await writeFile(join(dir, 'app', 'main.js'), 'main')
    await writeFile(join(appDir, 'z.js'), 'z')
    await writeFile(join(appDir, 'a.js'), 'a')

    const out = join(tmpdir(), `ota-order-${Date.now()}.tgz`)
    try {
      await createTarball(dir, out)
      const {stdout} = await execFileAsync('tar', ['-tzf', out])
      const members = stdout
        .trim()
        .split('\n')
        .map((m) => m.replace(/\/$/, ''))
      expect(members).toEqual([
        'app',
        'app/main.js',
        'app/nested',
        'app/nested/a.js',
        'app/nested/z.js',
      ])
    } finally {
      rmSync(out, {force: true})
    }
  })
})

describe('snapshotVersion', () => {
  // A fixed instant so the timestamp path is deterministic: 2026-07-23T00:32:05Z.
  const now = new Date(Date.UTC(2026, 6, 23, 0, 32, 5))
  const sha = '0a1b2c3d4e5f'

  it('appends a prerelease with the g-prefixed sha on a clean tree', () => {
    expect(snapshotVersion('1.2.3', {sha, dirty: false}, now)).toBe('1.2.3-snapshot.g0a1b2c3d4e5f')
  })

  it('marks a dirty tree and disambiguates with a UTC timestamp', () => {
    expect(snapshotVersion('1.2.3', {sha, dirty: true}, now)).toBe(
      '1.2.3-snapshot.g0a1b2c3d4e5f-dirty.20260723T003205Z',
    )
  })

  it('uses only the timestamp outside a git repo', () => {
    expect(snapshotVersion('1.2.3', {sha: null, dirty: false}, now)).toBe(
      '1.2.3-snapshot.20260723T003205Z',
    )
  })

  it('extends an existing prerelease with a dot, not a second hyphen', () => {
    expect(snapshotVersion('1.2.3-beta.1', {sha, dirty: false}, now)).toBe(
      '1.2.3-beta.1.snapshot.g0a1b2c3d4e5f',
    )
  })

  it('strips build metadata off the base before appending', () => {
    expect(snapshotVersion('1.2.3+foo', {sha, dirty: false}, now)).toBe(
      '1.2.3-snapshot.g0a1b2c3d4e5f',
    )
  })

  it('produces valid semver in every case, incl. a leading-zero all-digit sha', () => {
    const cases: GitSnapshotState[] = [
      {sha, dirty: false},
      {sha, dirty: true},
      {sha: null, dirty: false},
      // An all-digit sha with a leading zero: invalid as a bare numeric
      // identifier, which the `g` prefix is there to prevent.
      {sha: '012345678901', dirty: false},
    ]
    for (const git of cases) {
      expect(semver.valid(snapshotVersion('1.2.3', git, now))).not.toBeNull()
    }
  })
})

describe('finalizeBuild + readManifestFromTarball', () => {
  it('round-trips the manifest and reports checksum + size', async () => {
    const appDir = join(dir, 'app')
    await mkdir(appDir, {recursive: true})
    await writeFile(join(appDir, 'main.bjs'), Buffer.from([13, 1, 2, 3]))

    const out = join(tmpdir(), `ota-final-${Date.now()}.tgz`)
    try {
      const artifact = await finalizeBuild(dir, out, {
        app: 'my-app',
        version: '1.2.0',
        firmwareVersion: '0.15.0',
        bytecodeVersion: 13,
      })
      expect(artifact.outPath).toBe(out)
      expect(artifact.checksum).toMatch(/^[0-9a-f]{64}$/)
      expect(artifact.size).toBeGreaterThan(0)
      expect(artifact.checksum).toBe(await sha256File(out))

      const manifest = await readManifestFromTarball(out)
      expect(manifest).toEqual({
        app: 'my-app',
        version: '1.2.0',
        firmwareVersion: '0.15.0',
        bytecodeVersion: 13,
      })
    } finally {
      rmSync(out, {force: true})
    }
  })

  // Source fields are baked into the manifest so `push --tarball` reports the
  // source the artifact was packed from, rather than inspecting the pusher's
  // machine (whose HEAD and package.json may belong to another project entirely).
  it('round-trips optional source fields', async () => {
    const appDir = join(dir, 'app')
    await mkdir(appDir, {recursive: true})
    await writeFile(join(appDir, 'main.bjs'), Buffer.from([13, 1]))

    const out = join(tmpdir(), `ota-prov-${Date.now()}.tgz`)
    try {
      await finalizeBuild(dir, out, {
        app: 'my-app',
        version: '1.2.0',
        firmwareVersion: '0.15.0',
        bytecodeVersion: 13,
        repository: 'https://github.com/acme/sensor',
        directory: 'examples/sensor',
        commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        dirty: true,
      })
      expect(await readManifestFromTarball(out)).toEqual({
        app: 'my-app',
        version: '1.2.0',
        firmwareVersion: '0.15.0',
        bytecodeVersion: 13,
        repository: 'https://github.com/acme/sensor',
        directory: 'examples/sensor',
        commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        dirty: true,
      })
    } finally {
      rmSync(out, {force: true})
    }
  })
})

describe('normalizeRepositoryUrl', () => {
  it('returns undefined for absent or empty values', () => {
    expect(normalizeRepositoryUrl(undefined)).toBeUndefined()
    expect(normalizeRepositoryUrl('')).toBeUndefined()
    expect(normalizeRepositoryUrl({})).toBeUndefined()
    expect(normalizeRepositoryUrl('   ')).toBeUndefined()
  })

  it('passes through and cleans an https url', () => {
    expect(normalizeRepositoryUrl('https://github.com/acme/sensor')).toBe(
      'https://github.com/acme/sensor',
    )
    expect(normalizeRepositoryUrl('https://github.com/acme/sensor.git')).toBe(
      'https://github.com/acme/sensor',
    )
    expect(normalizeRepositoryUrl('https://github.com/acme/sensor/')).toBe(
      'https://github.com/acme/sensor',
    )
  })

  it('reads the url out of the object form', () => {
    expect(normalizeRepositoryUrl({url: 'git+https://github.com/acme/sensor.git'})).toBe(
      'https://github.com/acme/sensor',
    )
  })

  it('expands host shorthands and bare owner/repo (github)', () => {
    expect(normalizeRepositoryUrl('acme/sensor')).toBe('https://github.com/acme/sensor')
    expect(normalizeRepositoryUrl('github:acme/sensor')).toBe('https://github.com/acme/sensor')
    expect(normalizeRepositoryUrl('gitlab:acme/sensor')).toBe('https://gitlab.com/acme/sensor')
    expect(normalizeRepositoryUrl('bitbucket:acme/sensor')).toBe(
      'https://bitbucket.org/acme/sensor',
    )
  })

  it('rewrites ssh and git remotes to https', () => {
    expect(normalizeRepositoryUrl('git@github.com:acme/sensor.git')).toBe(
      'https://github.com/acme/sensor',
    )
    expect(normalizeRepositoryUrl('git://github.com/acme/sensor.git')).toBe(
      'https://github.com/acme/sensor',
    )
    expect(normalizeRepositoryUrl('ssh://git@github.com/acme/sensor.git')).toBe(
      'https://github.com/acme/sensor',
    )
  })

  it('drops values that cannot be resolved to an http(s) url', () => {
    expect(normalizeRepositoryUrl('file:///local/path')).toBeUndefined()
    expect(normalizeRepositoryUrl('javascript:alert(1)')).toBeUndefined()
  })

  // A CI checkout's package.json can carry a tokenised remote, and this url is
  // uploaded to the registry and shown to anyone who can read the build.
  it('strips credentials out of the url', () => {
    expect(normalizeRepositoryUrl('https://x-access-token:ghp_secret@github.com/acme/sensor')).toBe(
      'https://github.com/acme/sensor',
    )
    expect(normalizeRepositoryUrl('git+https://user:pw@github.com/acme/sensor.git')).toBe(
      'https://github.com/acme/sensor',
    )
  })

  it('accepts an uppercase scheme (schemes are case-insensitive)', () => {
    expect(normalizeRepositoryUrl('HTTPS://GitHub.com/acme/sensor')).toBe(
      'https://github.com/acme/sensor',
    )
  })

  it('drops a #committish rather than gluing it to the path', () => {
    expect(normalizeRepositoryUrl('git@github.com:acme/sensor.git#main')).toBe(
      'https://github.com/acme/sensor',
    )
  })
})

describe('normalizeRepositoryDirectory', () => {
  it('reads a relative path out of the object form only', () => {
    expect(normalizeRepositoryDirectory({directory: 'examples/sensor'})).toBe('examples/sensor')
    expect(normalizeRepositoryDirectory({directory: './packages/app/'})).toBe('packages/app')
    // A leading slash is a stray anchor, not an escape: the repo root is where
    // it resolves either way.
    expect(normalizeRepositoryDirectory({directory: '/packages/app'})).toBe('packages/app')
    expect(normalizeRepositoryDirectory('https://github.com/acme/sensor')).toBeUndefined()
    expect(normalizeRepositoryDirectory({})).toBeUndefined()
    expect(normalizeRepositoryDirectory({directory: '   '})).toBeUndefined()
  })

  // A registry composes this onto the repository url, so anything that would
  // escape or malform the link is dropped rather than passed on.
  it('drops paths that would escape or malform the link', () => {
    expect(normalizeRepositoryDirectory({directory: '../secrets'})).toBeUndefined()
    expect(normalizeRepositoryDirectory({directory: 'packages/../../etc'})).toBeUndefined()
    expect(normalizeRepositoryDirectory({directory: 'packages\\app'})).toBeUndefined()
    expect(normalizeRepositoryDirectory({directory: 'a b'})).toBeUndefined()
  })
})
