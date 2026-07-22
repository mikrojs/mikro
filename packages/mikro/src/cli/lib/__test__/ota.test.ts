import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtempSync, rmSync, utimesSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {promisify} from 'node:util'

import {mkdir, readdir, readFile, writeFile} from 'fs/promises'
import {join} from 'path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  createTarball,
  finalizeBuild,
  MANIFEST_NAME,
  pruneMacSidecars,
  readBytecodeVersion,
  readManifestFromTarball,
  sha256File,
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
})
