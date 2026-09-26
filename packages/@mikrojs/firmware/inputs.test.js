import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterAll, expect, test} from 'vitest'

/* Native module resolution as the firmware build runs it: `mikro-fw
 * inputs <project> --native-modules=…`, a real Node process. */

const cliJs = join(import.meta.dirname, 'cli.js')
// Real path: resolution reports real paths (/private/var vs /var on macOS)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-fw-resolve-')))

afterAll(() => {
  rmSync(root, {recursive: true, force: true})
})

function write(file, content) {
  mkdirSync(dirname(file), {recursive: true})
  writeFileSync(file, content)
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

/* A firmware project. */
function project(name) {
  const dir = join(root, name)
  write(join(dir, 'package.json'), json({name, private: true}))
  return dir
}

/** The export of a native module: C/C++ source, typed by a .d.ts next to it. */
function nativeExport(path) {
  return {types: `${path}.d.ts`, native: `${path}.cpp`}
}

/** A module directory. Native: C++ source, its types and the ESP-IDF component
 *  in place. Pure JS: a module, and nothing that marks it as native. */
function moduleDir(dir, {native = true} = {}) {
  const name = dir.split('/').at(-1)
  if (native) {
    write(join(dir, `${name}.cpp`), '// registers the module\n')
    write(join(dir, `${name}.d.ts`), `export declare const ${name}: number\n`)
    write(join(dir, 'CMakeLists.txt'), 'idf_component_register()\n')
  } else {
    write(join(dir, `${name}.ts`), `export const ${name} = 1\n`)
  }
}

/** The full output, `configureDepends` (the files CMake watches) included. */
function run(dir, {nativeModules} = {}) {
  const args = [cliJs, 'inputs', dir]
  if (nativeModules !== undefined) args.push(`--native-modules=${nativeModules}`)
  const out = JSON.parse(execFileSync('node', args, {encoding: 'utf8', stdio: 'pipe'}))
  // Order is not part of the contract
  out.components = out.components.split(';').filter(Boolean).sort().join(';')
  return out
}

/** The build inputs, without the watched files (see run) or the package paths. */
function resolveInputs(dir, options) {
  const out = run(dir, options)
  delete out.configureDepends
  delete out.quickjsCmake
  delete out.native
  return out
}

function resolveError(dir, options) {
  try {
    resolveInputs(dir, options)
  } catch (e) {
    expect(e.status).toBe(1)
    return e.stderr
  }
  throw new Error('expected resolution to fail')
}

function components(...dirs) {
  return dirs.sort().join(';')
}

const empty = {components: '', nativeModules: '', sdkconfigs: ''}

test('no native modules is a generic build', () => {
  const dir = project('generic')
  expect(resolveInputs(dir)).toEqual(empty)
  expect(resolveInputs(dir, {nativeModules: ''})).toEqual(empty)
})

test('each listed native module is compiled in, from wherever the package is installed', () => {
  const dir = project('listed')
  // Laid out like pnpm's store: the real package behind a symlink.
  const drivers = join(root, 'store/node_modules/@fx/drivers')
  mkdirSync(join(dir, 'node_modules/@fx'), {recursive: true})
  symlinkSync(drivers, join(dir, 'node_modules/@fx/drivers'))
  write(
    join(drivers, 'package.json'),
    json({
      name: '@fx/drivers',
      type: 'module',
      exports: {'./d1': nativeExport('./d1/d1'), './d2': nativeExport('./d2/d2')},
    }),
  )
  moduleDir(join(drivers, 'd1'))
  moduleDir(join(drivers, 'd2'))

  const out = run(dir, {nativeModules: '@fx/drivers/d2;@fx/drivers/d1'})
  const linked = join(dir, 'node_modules/@fx/drivers')
  expect(out.components).toBe(components(join(linked, 'd1'), join(linked, 'd2')))
  expect(out.nativeModules).toBe('@fx/drivers/d1;@fx/drivers/d2')
  // CMake re-runs the resolution when a package.json changes; native sources
  // are compiled, not read here.
  const inputs = out.configureDepends.split(';')
  expect(inputs).toContain(join(dir, 'package.json'))
  expect(inputs).toContain(join(linked, 'package.json'))
  expect(inputs.some((file) => file.endsWith('.cpp'))).toBe(false)
  // Installed but not listed: not compiled in
  expect(resolveInputs(dir)).toEqual(empty)
})

test('a listed specifier that is not an installed native module fails the build', () => {
  const dir = project('unresolvable')
  expect(resolveError(dir, {nativeModules: 'nope/fx'})).toContain(
    'MIKROJS_NATIVE_MODULES names "nope/fx", but no package "nope" is installed',
  )
  const pkg = join(dir, 'node_modules/fx')
  write(
    join(pkg, 'package.json'),
    json({name: 'fx', type: 'module', exports: {'./js': './js.js', './c': nativeExport('./c/c')}}),
  )
  moduleDir(join(pkg, 'c'))
  // A JavaScript export, and a subpath the package does not export
  for (const specifier of ['fx/js', 'fx/missing']) {
    expect(resolveError(dir, {nativeModules: specifier})).toContain(
      `MIKROJS_NATIVE_MODULES names "${specifier}", which is not a native module`,
    )
  }
})

test("a dependency's package.json that cannot be read fails the build, naming the file", () => {
  const dir = project('broken-dependency')
  write(join(dir, 'package.json'), json({name: 'broken-dependency', dependencies: {bad: '*'}}))
  write(join(dir, 'node_modules/bad/package.json'), '{"name": "bad",')
  expect(resolveError(dir)).toContain(`cannot read ${join(dir, 'node_modules/bad/package.json')}:`)
})

test('a native module whose directory is not an ESP-IDF component is rejected', () => {
  const dir = project('no-cmake')
  const pkg = join(dir, 'node_modules/pi')
  write(
    join(pkg, 'package.json'),
    json({name: 'pi', type: 'module', exports: {'./digits': nativeExport('./digits/digits')}}),
  )
  write(join(pkg, 'digits/digits.cpp'), '// registers the module\n')
  expect(resolveError(dir, {nativeModules: 'pi/digits'})).toContain('has no CMakeLists.txt')
})

test('two native modules with the same component name are rejected', () => {
  const dir = project('duplicate')
  for (const scope of ['@a', '@b']) {
    const pkg = join(dir, `node_modules/${scope}/led`)
    write(
      join(pkg, 'package.json'),
      json({name: `${scope}/led`, type: 'module', exports: {'.': nativeExport('./led')}}),
    )
    moduleDir(pkg)
  }
  expect(resolveError(dir, {nativeModules: '@a/led;@b/led'})).toContain(
    'both have a component named "led"',
  )
})

test('native modules whose sources share a directory are one component', () => {
  const dir = project('shared-dir')
  const pkg = join(dir, 'node_modules/gfx')
  write(
    join(pkg, 'package.json'),
    json({
      name: 'gfx',
      type: 'module',
      exports: {'./gfx': nativeExport('./gfx/gfx'), './dma': nativeExport('./gfx/dma')},
    }),
  )
  moduleDir(join(pkg, 'gfx'))
  write(join(pkg, 'gfx/dma.cpp'), '// registers dma\n')
  expect(resolveInputs(dir, {nativeModules: 'gfx/gfx;gfx/dma'}).components).toBe(join(pkg, 'gfx'))
})

test('a native module named like a firmware component is rejected', () => {
  const dir = project('reserved')
  const pkg = join(dir, 'node_modules/app')
  write(
    join(pkg, 'package.json'),
    json({
      name: 'app',
      type: 'module',
      exports: {
        './main': nativeExport('./main/main'),
        './mikrojs': nativeExport('./mikrojs/mikrojs'),
      },
    }),
  )
  moduleDir(join(pkg, 'main'))
  moduleDir(join(pkg, 'mikrojs'))
  for (const name of ['main', 'mikrojs']) {
    expect(resolveError(dir, {nativeModules: `app/${name}`})).toContain(
      `has a component named "${name}"`,
    )
  }
})

test('a native export with a host version for other tools is still a native module', () => {
  const dir = project('host-default')
  const pkg = join(dir, 'node_modules/bme')
  write(
    join(pkg, 'package.json'),
    json({
      name: 'bme',
      type: 'module',
      exports: {'.': {types: './bme.d.ts', native: './bme.cpp', default: './bme.host.js'}},
    }),
  )
  moduleDir(pkg)
  write(join(pkg, 'bme.host.js'), 'export const bme = 1\n')
  expect(resolveInputs(dir, {nativeModules: 'bme'}).components).toBe(pkg)
})
