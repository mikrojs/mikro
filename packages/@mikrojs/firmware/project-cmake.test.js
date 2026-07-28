import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {isAbsolute, join} from 'node:path'

import {afterAll, expect, test} from 'vitest'

import {discover} from './discover.js'

/* Configure a minimal consumer project against project.cmake with plain CMake
 * (no ESP-IDF) and assert that a driver dependency from the CONSUMER's
 * package.json ends up in EXTRA_COMPONENT_DIRS. Regression test for discovery
 * scanning @mikrojs/firmware's own package.json instead of the consuming
 * project's (CMAKE_CURRENT_LIST_DIR vs CMAKE_SOURCE_DIR), which silently
 * dropped all external board/driver components from the firmware image. */

function hasCmake() {
  try {
    execFileSync('cmake', ['--version'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

const projectCmake = join(import.meta.dirname, 'project.cmake')
const fixtureDir = mkdtempSync(join(tmpdir(), 'mik-fw-discover-'))

afterAll(() => {
  rmSync(fixtureDir, {recursive: true, force: true})
})

test('discovery is empty for projects without a package.json', () => {
  // On-device test apps (esp32/test, the firmware package's test/) configure
  // through project.cmake but have no package.json to scan
  const emptyDir = join(fixtureDir, 'no-package-json')
  mkdirSync(emptyDir)
  expect(discover(emptyDir)).toEqual({components: '', sdkconfigs: ''})
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
  'driver components from the consuming project land in EXTRA_COMPONENT_DIRS',
  () => {
    writeFileSync(
      join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-firmware',
        private: true,
        dependencies: {'fake-driver': '*'},
      }),
    )

    const driverDir = join(fixtureDir, 'node_modules', 'fake-driver')
    mkdirSync(join(driverDir, 'component'), {recursive: true})
    writeFileSync(
      join(driverDir, 'package.json'),
      JSON.stringify({name: 'fake-driver', version: '1.0.0'}),
    )
    // cmake.js files are CommonJS (loaded via require() in discover.js)
    writeFileSync(
      join(driverDir, 'cmake.js'),
      "module.exports = {componentPath: require('node:path').join(__dirname, 'component')}\n",
    )

    writeFileSync(
      join(fixtureDir, 'CMakeLists.txt'),
      [
        'cmake_minimum_required(VERSION 3.22)',
        // Stand in for the variables ESP-IDF defines before project.cmake runs
        'set(IDF_VERSION_MAJOR 6)',
        'set(IDF_VERSION_MINOR 0)',
        'set(IDF_VERSION_PATCH 1)',
        'set(IDF_TARGET esp32s3)',
        'project(fixture NONE)',
        `include("${projectCmake}")`,
        'message(STATUS "TEST_EXTRA_COMPONENT_DIRS=${EXTRA_COMPONENT_DIRS}")',
        '',
      ].join('\n'),
    )

    const out = execFileSync('cmake', ['-S', fixtureDir, '-B', join(fixtureDir, 'build')], {
      encoding: 'utf8',
    })

    const line = out.split('\n').find((l) => l.includes('TEST_EXTRA_COMPONENT_DIRS='))
    expect(line).toBeDefined()
    // Suffix match: the tmpdir prefix can differ between the fixture path and
    // require()'s symlink-resolved __dirname on macOS (/var vs /private/var)
    expect(line).toContain(join('node_modules', 'fake-driver', 'component'))
  },
  30_000,
)

/* Partition table path healing. An sdkconfig created before the
 * build/partitions.csv indirection (or by an older @mikrojs/firmware) froze
 * an absolute store path into CONFIG_PARTITION_TABLE_CUSTOM_FILENAME;
 * sdkconfig wins over defaults fragments, so upgrades broke the build. */

function makePartitionFixture(name) {
  const dir = join(fixtureDir, name)
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'CMakeLists.txt'),
    [
      'cmake_minimum_required(VERSION 3.22)',
      'set(IDF_VERSION_MAJOR 6)',
      'set(IDF_VERSION_MINOR 0)',
      'set(IDF_VERSION_PATCH 1)',
      'set(IDF_TARGET esp32s3)',
      'project(fixture NONE)',
      `include("${projectCmake}")`,
      '',
    ].join('\n'),
  )
  return dir
}

test.skipIf(!hasCmake())(
  'sdkconfig frozen to a path outside the project is repointed, even when that path exists',
  () => {
    const dir = makePartitionFixture('heal-stale')
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

    execFileSync('cmake', ['-S', dir, '-B', join(dir, 'build')], {encoding: 'utf8'})

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
    const dir = makePartitionFixture('heal-override')
    const before = 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="my-partitions.csv"\n'
    writeFileSync(join(dir, 'sdkconfig'), before)

    execFileSync('cmake', ['-S', dir, '-B', join(dir, 'build')], {encoding: 'utf8'})

    expect(readFileSync(join(dir, 'sdkconfig'), 'utf8')).toBe(before)
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'a build dir outside the project gets an absolute path and no stray build/ in the source tree',
  () => {
    const dir = makePartitionFixture('external-build-src')
    const buildDir = join(fixtureDir, 'external-build-bin')

    execFileSync('cmake', ['-S', dir, '-B', buildDir], {encoding: 'utf8'})

    const fragment = readFileSync(join(buildDir, 'sdkconfig.partitions'), 'utf8')
    const value = fragment.match(/CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="([^"]*)"/)?.[1]
    expect(value).toBeDefined()
    expect(isAbsolute(value)).toBe(true)
    expect(existsSync(value)).toBe(true)
    expect(existsSync(join(dir, 'build'))).toBe(false)
  },
  30_000,
)
