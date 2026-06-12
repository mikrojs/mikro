import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterAll, expect, test} from 'vitest'

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
