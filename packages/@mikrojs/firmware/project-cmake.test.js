import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, isAbsolute, join} from 'node:path'

import {afterAll, expect, test} from 'vitest'

import {resolveFirmwareInputs} from './inputs.js'

/* Configure minimal consumer projects against project.cmake with plain CMake
 * (no ESP-IDF) and assert what reaches the build: which components land in
 * EXTRA_COMPONENT_DIRS, and the healing of frozen partition paths. Resolution runs from
 * the CONSUMER's directory (CMAKE_SOURCE_DIR), not this package's — while
 * include()d, CMAKE_CURRENT_LIST_DIR is @mikrojs/firmware inside node_modules. */

function hasCmake() {
  try {
    execFileSync('cmake', ['--version'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

const projectCmake = join(import.meta.dirname, 'project.cmake')
const fixtureDir = mkdtempSync(join(tmpdir(), 'mik-fw-cmake-'))

afterAll(() => {
  rmSync(fixtureDir, {recursive: true, force: true})
})

function write(file, content) {
  mkdirSync(dirname(file), {recursive: true})
  writeFileSync(file, content)
}

/** A consumer project; `lines` go before the include (set(MIKROJS_NATIVE_MODULES ...)). */
function makeProject(name, {lines = []} = {}) {
  const dir = join(fixtureDir, name)
  write(
    join(dir, 'CMakeLists.txt'),
    [
      'cmake_minimum_required(VERSION 3.22)',
      // Stand in for the variables ESP-IDF defines before project.cmake runs
      'set(IDF_VERSION_MAJOR 6)',
      'set(IDF_VERSION_MINOR 1)',
      'set(IDF_VERSION_PATCH 0)',
      'set(IDF_TARGET esp32s3)',
      'project(fixture NONE)',
      ...lines,
      `include("${projectCmake}")`,
      'message(STATUS "TEST_EXTRA_COMPONENT_DIRS=${EXTRA_COMPONENT_DIRS}")',
      '',
    ].join('\n'),
  )
  return dir
}

function configure(dir, {args = [], env = {}, buildDir = join(dir, 'build')} = {}) {
  const out = execFileSync('cmake', ['-S', dir, '-B', buildDir, ...args], {
    encoding: 'utf8',
    env: {...process.env, ...env},
    stdio: 'pipe',
  })
  const vars = {}
  for (const match of out.matchAll(/TEST_(\w+)=(.*)/g)) vars[match[1]] = match[2]
  return vars
}

/** A package with one native module, `<name>/<module>`, installed in the project. */
function installFakeNativePackage(dir, name = 'fake-native', module = 'fx') {
  const packageDir = join(dir, 'node_modules', name)
  write(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      exports: {
        [`./${module}`]: {types: `./${module}/${module}.d.ts`, native: `./${module}/${module}.cpp`},
      },
    }),
  )
  write(join(packageDir, `${module}/${module}.cpp`), '// registers the module\n')
  write(join(packageDir, `${module}/${module}.d.ts`), `export declare const ${module}: number\n`)
  write(join(packageDir, `${module}/CMakeLists.txt`), 'idf_component_register()\n')
  return packageDir
}

test('resolution is empty for projects without a package.json', async () => {
  // On-device test apps (esp32/test, the firmware package's test/) configure
  // through project.cmake but have no package.json
  const emptyDir = join(fixtureDir, 'no-package-json')
  mkdirSync(emptyDir)
  expect(await resolveFirmwareInputs(emptyDir)).toEqual({
    components: '',
    nativeModules: '',
    sdkconfigs: '',
    configureDepends: '',
  })
})

test('projectName resolves the consuming project package.json name', () => {
  const resolve = join(import.meta.dirname, 'resolve.js')
  const dir = join(fixtureDir, 'named-project')
  mkdirSync(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'acme-sensor-fw'}))
  expect(execFileSync('node', [resolve, 'projectName', dir], {encoding: 'utf8'})).toBe(
    'acme-sensor-fw',
  )

  // No package.json (on-device test apps): empty output, so CMake defines
  // no MIK_FW_NAME and the device omits the fw identity.
  const emptyDir = join(fixtureDir, 'unnamed-project')
  mkdirSync(emptyDir)
  expect(execFileSync('node', [resolve, 'projectName', emptyDir], {encoding: 'utf8'})).toBe('')
})

test.skipIf(!hasCmake())(
  'declared native modules land in EXTRA_COMPONENT_DIRS; installed but undeclared ones do not',
  () => {
    const declared = makeProject('native-declared', {
      lines: ['set(MIKROJS_NATIVE_MODULES "fake-native/fx")'],
    })
    installFakeNativePackage(declared)
    const vars = configure(declared)
    // Suffix match: resolution reports real paths (/private/var vs /var on macOS)
    expect(vars.EXTRA_COMPONENT_DIRS).toContain(join('node_modules', 'fake-native', 'fx'))

    const undeclared = makeProject('native-undeclared')
    installFakeNativePackage(undeclared)
    expect(configure(undeclared).EXTRA_COMPONENT_DIRS).not.toContain('fake-native')
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'a native module named like an ESP-IDF component fails to configure',
  () => {
    const dir = makeProject('idf-clash', {lines: ['set(MIKROJS_NATIVE_MODULES "fake-native/fx")']})
    installFakeNativePackage(dir)
    // The native module's directory is named fx; so is this IDF component
    const idf = join(fixtureDir, 'fake-idf')
    write(join(idf, 'components/fx/CMakeLists.txt'), '')
    expect(() => configure(dir, {env: {IDF_PATH: idf}})).toThrow(
      /is named "fx", like an ESP-IDF component/,
    )
    expect(() =>
      configure(dir, {buildDir: join(dir, 'build-no-clash'), env: {IDF_PATH: ''}}),
    ).not.toThrow()
  },
  30_000,
)

test.skipIf(!hasCmake())(
  "a native module named like one of the project's components fails to configure",
  () => {
    for (const where of ['components', 'managed_components']) {
      const dir = makeProject(`own-clash-${where}`, {
        lines: ['set(MIKROJS_NATIVE_MODULES "fake-native/fx")'],
      })
      installFakeNativePackage(dir)
      write(join(dir, where, 'fx/CMakeLists.txt'), '')
      expect(() => configure(dir, {env: {IDF_PATH: ''}}), where).toThrow(
        /is named "fx", like the\s+project's component/,
      )
    }
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'MIKROJS_NATIVE_MODULES precedence is -D, then environment, then set()',
  () => {
    const dir = makeProject('native-precedence', {
      lines: ['set(MIKROJS_NATIVE_MODULES "n-set/nset")'],
    })
    installFakeNativePackage(dir, 'n-set', 'nset')
    installFakeNativePackage(dir, 'n-env', 'nenv')
    installFakeNativePackage(dir, 'n-cache', 'ncache')
    const components = (options) => {
      const dirs = configure(dir, options).EXTRA_COMPONENT_DIRS
      return ['nset', 'nenv', 'ncache'].filter((name) => dirs.includes(`/${name}`))
    }
    expect(components({buildDir: join(dir, 'build-set')})).toEqual(['nset'])
    expect(
      components({buildDir: join(dir, 'build-env'), env: {MIKROJS_NATIVE_MODULES: 'n-env/nenv'}}),
    ).toEqual(['nenv'])
    expect(
      components({
        buildDir: join(dir, 'build-cache'),
        args: ['-DMIKROJS_NATIVE_MODULES=n-cache/ncache'],
        env: {MIKROJS_NATIVE_MODULES: 'n-env/nenv'},
      }),
    ).toEqual(['ncache'])
  },
  60_000,
)

test.skipIf(!hasCmake())(
  'an unresolvable native module fails to configure with the resolver message',
  () => {
    const dir = makeProject('native-missing', {lines: ['set(MIKROJS_NATIVE_MODULES "nope/fx")']})
    expect(() => configure(dir)).toThrow(/names "nope\/fx", but no package "nope" is installed/)
  },
  30_000,
)

/* Partition table path healing. An sdkconfig created before the
 * build/partitions.csv indirection (or by an older @mikrojs/firmware) froze
 * an absolute store path into CONFIG_PARTITION_TABLE_CUSTOM_FILENAME;
 * sdkconfig wins over defaults fragments, so upgrades broke the build. */

test.skipIf(!hasCmake())(
  'sdkconfig frozen to a path outside the project is repointed, even when that path exists',
  () => {
    const dir = makeProject('heal-stale')
    // The firmware package's own partitions.csv: a realistic frozen store
    // path that still exists on disk, like an older version kept in the store
    const stale = join(import.meta.dirname, 'partitions.csv')
    writeFileSync(
      join(dir, 'sdkconfig'),
      [
        `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${stale}"`,
        `CONFIG_PARTITION_TABLE_FILENAME="${stale}"`,
        '',
      ].join('\n'),
    )

    configure(dir)

    const sdkconfig = readFileSync(join(dir, 'sdkconfig'), 'utf8')
    expect(sdkconfig).toContain('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="build/partitions.csv"')
    // The derived twin must not keep quoting the stale path either
    expect(sdkconfig).toContain('CONFIG_PARTITION_TABLE_FILENAME="build/partitions.csv"')
    expect(sdkconfig).not.toContain(stale)
    expect(existsSync(join(dir, 'build', 'partitions.csv'))).toBe(true)
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'sdkconfig pointing at a file inside the project (menuconfig override) is left alone',
  () => {
    const dir = makeProject('heal-override')
    const before = 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="my-partitions.csv"\n'
    writeFileSync(join(dir, 'sdkconfig'), before)

    configure(dir)

    expect(readFileSync(join(dir, 'sdkconfig'), 'utf8')).toBe(before)
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'a build dir outside the project gets an absolute path and no stray build/ in the source tree',
  () => {
    const dir = makeProject('external-build-src')
    const buildDir = join(fixtureDir, 'external-build-bin')

    configure(dir, {buildDir})

    const fragment = readFileSync(join(buildDir, 'sdkconfig.partitions'), 'utf8')
    const value = fragment.match(/CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="([^"]*)"/)?.[1]
    expect(value).toBeDefined()
    expect(isAbsolute(value)).toBe(true)
    expect(existsSync(value)).toBe(true)
    expect(existsSync(join(dir, 'build'))).toBe(false)
  },
  30_000,
)
