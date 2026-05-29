import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {scaffold, TEMPLATES} from './scaffold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatesDir = __dirname + '/templates'
const mikrojsPkgDir = path.resolve(__dirname, '..', '..', 'mikrojs')
const createMikrojsPkgDir = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(__dirname, '..', '..', '..')
const cmNodeModules = path.resolve(createMikrojsPkgDir, 'node_modules')

const tscBin = path.resolve(cmNodeModules, '.bin', 'tsc')
const eslintBin = path.resolve(cmNodeModules, '.bin', 'eslint')
const prettierBin = path.resolve(cmNodeModules, '.bin', 'prettier')

// Packages the scaffolded project's eslint/prettier/tsc need to resolve.
// Paths point at the workspace install so the test doesn't actually
// install anything into the temp project.
const DEPS_TO_LINK: ReadonlyArray<readonly [src: string, dst: string]> = [
  [mikrojsPkgDir, 'mikrojs'],
  [path.join(cmNodeModules, 'eslint'), 'eslint'],
  [path.join(cmNodeModules, 'prettier'), 'prettier'],
  [path.join(cmNodeModules, 'typescript'), 'typescript'],
  [path.join(cmNodeModules, 'typescript-eslint'), 'typescript-eslint'],
  [path.join(cmNodeModules, '@mikrojs/eslint-plugin'), '@mikrojs/eslint-plugin'],
  [path.join(workspaceRoot, 'node_modules/@eslint/js'), '@eslint/js'],
]

// Extra packages needed for specific templates beyond DEPS_TO_LINK.
const EXTRA_TYPE_DEPS: Record<string, Record<string, string>> = {}

function installDeps(targetDir: string, name: string) {
  const nodeModules = path.join(targetDir, 'node_modules')
  mkdirSync(nodeModules, {recursive: true})
  for (const [src, rel] of DEPS_TO_LINK) {
    const dst = path.join(nodeModules, rel)
    mkdirSync(path.dirname(dst), {recursive: true})
    symlinkSync(src, dst)
  }
  const extras = EXTRA_TYPE_DEPS[name]
  if (extras) {
    for (const [pkg, pkgPath] of Object.entries(extras)) {
      const dst = path.join(nodeModules, pkg)
      mkdirSync(path.dirname(dst), {recursive: true})
      symlinkSync(pkgPath, dst)
    }
  }
}

describe.each(TEMPLATES)('template: $name', ({name}) => {
  let tempDir: string
  let targetDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), `create-mikrojs-test-${name}-`))
    targetDir = path.join(tempDir, 'test-project')
  })

  afterEach(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  beforeEach(() => {
    scaffold({
      targetDir,
      template: name,
      projectName: 'test-project',
      mikrojsVersion: '0.0.0',
      templatesDir,
      pkgManager: 'npm',
    })
  })

  it('creates package.json with correct fields', () => {
    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf-8'))
    expect(pkg.name).toBe('test-project')
    expect(pkg.type).toBe('module')
    expect(pkg.main).toBe('./app/main.ts')
    expect(pkg.dependencies.mikrojs).toBe('^0.0.0')
    expect(pkg.devDependencies.typescript).toBeDefined()
    expect(pkg.devDependencies.prettier).toBeDefined()
    expect(pkg.scripts.lint).toBe('eslint .')
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit --pretty')
    expect(pkg.scripts.format).toBe('prettier --write .')
    expect(pkg.scripts['format:check']).toBe('prettier --check .')
    expect(pkg.scripts.dev).toBeUndefined()
    expect(pkg.scripts.flash).toBeUndefined()
    expect(pkg.engines).toBeUndefined()
  })

  it('creates tsconfig.json extending the mikrojs base config', () => {
    const tsconfig = JSON.parse(readFileSync(path.join(targetDir, 'tsconfig.json'), 'utf-8'))
    expect(tsconfig.extends).toBe('mikrojs/tsconfig')
    expect(tsconfig.include).toContain('app/**/*')
    expect(tsconfig.include).toContain('mikro.config.ts')
  })

  it('creates .gitignore', () => {
    const content = readFileSync(path.join(targetDir, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules')
    expect(content).toContain('.mikro')
  })

  it('creates .editorconfig', () => {
    const content = readFileSync(path.join(targetDir, '.editorconfig'), 'utf-8')
    expect(content).toContain('root = true')
    expect(content).toContain('indent_style')
  })

  it('creates eslint.config.js with mikrojs plugin', () => {
    const content = readFileSync(path.join(targetDir, 'eslint.config.js'), 'utf-8')
    expect(content).toContain('@mikrojs/eslint-plugin')
    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf-8'))
    expect(pkg.devDependencies.eslint).toBeDefined()
    expect(pkg.devDependencies['@mikrojs/eslint-plugin']).toBeDefined()
  })

  it('creates app/main.ts', () => {
    const content = readFileSync(path.join(targetDir, 'app', 'main.ts'), 'utf-8')
    expect(content.length).toBeGreaterThan(0)
  })

  it('creates mikro.config.ts with defineConfig', () => {
    const content = readFileSync(path.join(targetDir, 'mikro.config.ts'), 'utf-8')
    expect(content).toContain('from "mikrojs"')
    expect(content).toContain('defineConfig')
    expect(content).toContain('https://mikrojs.dev/config')
  })

  it('type-checks against mikrojs types', () => {
    installDeps(targetDir, name)
    execFileSync(tscBin, ['--noEmit'], {
      cwd: targetDir,
      stdio: 'pipe',
      env: {...process.env, NODE_OPTIONS: ''},
    })
  })

  it('passes eslint', () => {
    installDeps(targetDir, name)
    execFileSync(eslintBin, ['--max-warnings=0', '.'], {
      cwd: targetDir,
      stdio: 'pipe',
      env: {...process.env, NODE_OPTIONS: ''},
    })
  })

  it('passes prettier --check', () => {
    installDeps(targetDir, name)
    execFileSync(prettierBin, ['--check', '.'], {
      cwd: targetDir,
      stdio: 'pipe',
      env: {...process.env, NODE_OPTIONS: ''},
    })
  })
})
