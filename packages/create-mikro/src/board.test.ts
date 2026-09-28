import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {scaffoldBoard} from './board.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(__dirname, '..', '..', '..')
const mikroPkgDir = path.join(workspaceRoot, 'packages/mikro')
const cmNodeModules = path.resolve(__dirname, '..', 'node_modules')
const tscBin = path.join(cmNodeModules, '.bin', 'tsc')

describe('board package', () => {
  let tempDir: string
  let targetDir: string

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'create-mikro-test-board-'))
    targetDir = path.join(tempDir, 'devboard')
    scaffoldBoard({
      targetDir,
      packageName: '@acme/devboard',
      chip: 'esp32s3',
      chipLabel: 'ESP32-S3',
      mikroVersion: '0.0.0',
      pkgManager: 'pnpm',
    })
    // The packages the board's build and the mikro CLI resolve, from the
    // workspace install
    const links: ReadonlyArray<readonly [src: string, dst: string]> = [
      [mikroPkgDir, 'mikro'],
      [path.join(workspaceRoot, 'packages/@mikrojs/firmware'), '@mikrojs/firmware'],
      [path.join(cmNodeModules, 'typescript'), 'typescript'],
      [path.join(cmNodeModules, 'tsx'), 'tsx'],
    ]
    for (const [src, rel] of links) {
      const dst = path.join(targetDir, 'node_modules', rel)
      mkdirSync(path.dirname(dst), {recursive: true})
      symlinkSync(src, dst)
    }
  })

  afterAll(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  const read = (file: string) => readFileSync(path.join(targetDir, file), 'utf-8')

  it('declares the board with a firmware export and publishes the image', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.name).toBe('@acme/devboard')
    expect(pkg.description).toBe('A development board with an ESP32-S3')
    expect(pkg.exports['.']).toEqual({firmware: './dist-fw/full/firmware.json'})
    expect(pkg.files).toContain('dist-fw')
    expect(pkg.scripts.prepack).toBe('pnpm build && mikro fw build')
    expect(pkg.peerDependencies.mikro).toBe('^0.0.0')
    // A direct dependency, or `mikro fw build` cannot resolve it under pnpm
    expect(pkg.devDependencies['@mikrojs/firmware']).toBe('^0.0.0')
    expect(pkg.private).toBeUndefined()
  })

  it("extends the chip's preset, without an include for apps to inherit", () => {
    expect(JSON.parse(read('tsconfig.json'))).toEqual({
      extends: 'mikro/tsconfig/esp32s3-generic',
    })
    expect(read('boards.config.ts')).toContain("chip: 'esp32s3'")
    for (const entry of ['node_modules', 'dist', 'dist-fw', '.mikro']) {
      expect(read('.gitignore')).toContain(`${entry}\n`)
    }
  })

  it('builds the pins module', () => {
    execFileSync(tscBin, ['-p', 'tsconfig.build.json'], {
      cwd: targetDir,
      stdio: 'pipe',
      env: {...process.env, NODE_OPTIONS: ''},
    })
    expect(existsSync(path.join(targetDir, 'dist/pins.js'))).toBe(true)
    expect(existsSync(path.join(targetDir, 'dist/pins.d.ts'))).toBe(true)
    // It would point at pins.ts, which isn't published
    expect(existsSync(path.join(targetDir, 'dist/pins.js.map'))).toBe(false)
  })

  it('has a boards.config.ts that matches its exports', () => {
    const out = execFileSync(
      process.execPath,
      [path.join(mikroPkgDir, 'bin/mikrojs.js'), 'fw', 'list', '--json'],
      {cwd: targetDir, encoding: 'utf-8', env: {...process.env, MIKROJS_WORKSPACE: '1'}},
    )
    expect(JSON.parse(out.trim().split('\n').at(-1)!).result).toEqual({
      boards: [{name: '@acme/devboard', chip: 'esp32s3', images: ['full']}],
    })
  })
})
