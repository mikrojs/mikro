import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {CHIPS, scaffold, TEMPLATES} from './scaffold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatesDir = __dirname + '/templates'
const mikroPkgDir = path.resolve(__dirname, '..', '..', 'mikro')
const createMikroPkgDir = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(__dirname, '..', '..', '..')
const cmNodeModules = path.resolve(createMikroPkgDir, 'node_modules')

const tscBin = path.resolve(cmNodeModules, '.bin', 'tsc')
const eslintBin = path.resolve(cmNodeModules, '.bin', 'eslint')
const prettierBin = path.resolve(cmNodeModules, '.bin', 'prettier')

// Packages the scaffolded project's eslint/prettier/tsc need to resolve.
// Paths point at the workspace install so the test doesn't actually
// install anything into the temp project.
const DEPS_TO_LINK: ReadonlyArray<readonly [src: string, dst: string]> = [
  [mikroPkgDir, 'mikro'],
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
    tempDir = mkdtempSync(path.join(tmpdir(), `create-mikro-test-${name}-`))
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
      mikroVersion: '0.0.0',
      templatesDir,
      pkgManager: 'npm',
    })
  })

  it('creates package.json with correct fields', () => {
    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf-8'))
    expect(pkg.name).toBe('test-project')
    expect(pkg.type).toBe('module')
    expect(pkg.main).toBe('./app/main.ts')
    expect(pkg.dependencies.mikro).toBe('^0.0.0')
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

  it('creates tsconfig.json extending the default chip preset', () => {
    const tsconfig = JSON.parse(readFileSync(path.join(targetDir, 'tsconfig.json'), 'utf-8'))
    expect(tsconfig.extends).toBe('mikro/tsconfig/esp32c6-generic')
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
    expect(content).toContain('from "mikro"')
    expect(content).toContain('defineConfig')
    expect(content).toContain('https://mikrojs.dev/config')
  })

  it('type-checks against mikro types', () => {
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

describe('chip option', () => {
  let tempDir: string
  let targetDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'create-mikro-test-options-'))
    targetDir = path.join(tempDir, 'test-project')
  })

  afterEach(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('offers exactly the chips the firmware supports', () => {
    // create-mikro ships standalone, so it keeps its own copy of the list.
    const {chips} = JSON.parse(
      readFileSync(path.join(workspaceRoot, 'packages/@mikrojs/firmware/chips.json'), 'utf-8'),
    ) as {chips: string[]}
    expect([...CHIPS]).toEqual(chips)
  })

  it('uses the selected chip for the tsconfig extends', () => {
    scaffold({
      targetDir,
      template: 'blank',
      projectName: 'test-project',
      mikroVersion: '0.0.0',
      templatesDir,
      pkgManager: 'npm',
      chip: 'esp32s3',
    })
    const tsconfig = JSON.parse(readFileSync(path.join(targetDir, 'tsconfig.json'), 'utf-8'))
    expect(tsconfig.extends).toBe('mikro/tsconfig/esp32s3-generic')
  })
})

describe('firmware option', () => {
  let tempDir: string
  let targetDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'create-mikro-test-firmware-'))
    targetDir = path.join(tempDir, 'test-project')
    scaffold({
      targetDir,
      template: 'blank',
      projectName: 'test-project',
      mikroVersion: '0.0.0',
      templatesDir,
      pkgManager: 'pnpm',
      chip: 'esp32s3',
      firmware: true,
    })
  })

  afterEach(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('makes the app its own firmware project, finding project.cmake through @mikrojs/firmware', () => {
    const cmake = readFileSync(path.join(targetDir, 'CMakeLists.txt'), 'utf-8')
    expect(cmake).toContain('npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32')
    expect(cmake).toContain('include(${_MIK_CMAKE_PATH})')
    expect(cmake).toContain('project(test-project)')
    // A direct dependency, or npx cannot find the bin under pnpm
    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf-8'))
    expect(pkg.dependencies['@mikrojs/firmware']).toBe('^0.0.0')
  })

  it('ignores what ESP-IDF writes and explains the build in the README', () => {
    const gitignore = readFileSync(path.join(targetDir, '.gitignore'), 'utf-8')
    for (const entry of ['managed_components/', 'dependencies.lock', 'sdkconfig']) {
      expect(gitignore).toContain(`\n${entry}\n`)
    }
    const readme = readFileSync(path.join(targetDir, 'README.md'), 'utf-8')
    expect(readme).toContain('pnpm mikro idf set-target esp32s3')
    expect(readme).toContain('pnpm mikro idf build flash')
    expect(readme).toContain('MIKROJS_NATIVE_MODULES')
  })

  it('leaves projects without the option alone', () => {
    const plain = path.join(tempDir, 'plain')
    scaffold({
      targetDir: plain,
      template: 'blank',
      projectName: 'plain',
      mikroVersion: '0.0.0',
      templatesDir,
      pkgManager: 'pnpm',
    })
    const pkg = JSON.parse(readFileSync(path.join(plain, 'package.json'), 'utf-8'))
    expect(pkg.dependencies['@mikrojs/firmware']).toBeUndefined()
    expect(existsSync(path.join(plain, 'CMakeLists.txt'))).toBe(false)
    expect(readFileSync(path.join(plain, '.gitignore'), 'utf-8')).not.toContain('sdkconfig')
  })
})
