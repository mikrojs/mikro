import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {scaffold, TEMPLATES} from './scaffold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatesDir = __dirname + '/templates'
const mikrojsPkgDir = path.resolve(__dirname, '..', '..', 'mikrojs')
const createMikrojsPkgDir = path.resolve(__dirname, '..')
const tscBin = path.resolve(createMikrojsPkgDir, 'node_modules', '.bin', 'tsc')

// Extra packages needed for type-checking specific templates
const EXTRA_TYPE_DEPS: Record<string, Record<string, string>> = {}

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

  describe('with typescript', () => {
    beforeEach(() => {
      scaffold({
        targetDir,
        template: name,
        projectName: 'test-project',
        mikrojsVersion: '0.0.0',
        typescript: true,
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
      expect(pkg.scripts.lint).toBe('eslint .')
      expect(pkg.scripts.typecheck).toBe('tsc --noEmit --pretty')
      expect(pkg.scripts.dev).toBeUndefined()
      expect(pkg.scripts.flash).toBeUndefined()
      expect(pkg.engines).toBeUndefined()
    })

    it('creates tsconfig.json with mikrojs runtime types', () => {
      const tsconfig = JSON.parse(readFileSync(path.join(targetDir, 'tsconfig.json'), 'utf-8'))
      expect(tsconfig.compilerOptions.types).toContain('mikrojs/runtime')
      expect(tsconfig.include).toContain('app/**/*')
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

    it('type-checks against mikrojs types', () => {
      // Symlink the workspace mikrojs package so tsc can resolve types
      const nodeModules = path.join(targetDir, 'node_modules')
      mkdirSync(nodeModules, {recursive: true})
      symlinkSync(mikrojsPkgDir, path.join(nodeModules, 'mikrojs'))

      // Symlink any extra dependencies needed for this template
      const extras = EXTRA_TYPE_DEPS[name]
      if (extras) {
        for (const [pkg, pkgPath] of Object.entries(extras)) {
          const dest = path.join(nodeModules, pkg)
          mkdirSync(path.dirname(dest), {recursive: true})
          symlinkSync(pkgPath, dest)
        }
      }

      execFileSync(tscBin, ['--noEmit'], {
        cwd: targetDir,
        stdio: 'pipe',
        env: {...process.env, NODE_OPTIONS: ''},
      })
    })
  })

  describe('without typescript', () => {
    beforeEach(() => {
      scaffold({
        targetDir,
        template: name,
        projectName: 'test-project',
        mikrojsVersion: '0.0.0',
        typescript: false,
        templatesDir,
        pkgManager: 'npm',
      })
    })

    it('does not include typescript in devDependencies', () => {
      const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf-8'))
      expect(pkg.devDependencies).toBeUndefined()
    })

    it('does not create tsconfig.json', () => {
      expect(existsSync(path.join(targetDir, 'tsconfig.json'))).toBe(false)
    })

    it('does not create eslint config', () => {
      expect(existsSync(path.join(targetDir, 'eslint.config.js'))).toBe(false)
    })

    it('still creates .editorconfig', () => {
      expect(existsSync(path.join(targetDir, '.editorconfig'))).toBe(true)
    })
  })
})
