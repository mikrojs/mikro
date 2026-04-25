#!/usr/bin/env node
/**
 * Resolve package paths for CMake. Called by CMakeLists.txt files.
 *
 * Usage: node resolve.js <query> [args...]
 *
 * Queries:
 *   componentDir     — EXTRA_COMPONENT_DIRS parent (contains mikrojs/)
 *   configDir        — directory with sdkconfig.defaults + partitions.csv
 *   defaultAppDir    — directory containing default main/ component
 *   projectCmakePath — path to project.cmake
 *   quickjs          — path to quickjs.cmake
 *   native           — JSON with native package paths
 *   version          — firmware package version
 *   discover <dir>   — discover board/driver components from project dir
 */
import {componentDir, projectCmakePath} from './cmake.js'
import {configDir, defaultAppDir} from './index.js'

const query = process.argv[2]

if (query === 'componentDir') {
  process.stdout.write(componentDir)
} else if (query === 'configDir') {
  process.stdout.write(configDir)
} else if (query === 'defaultAppDir') {
  process.stdout.write(defaultAppDir)
} else if (query === 'projectCmakePath') {
  process.stdout.write(projectCmakePath)
} else if (query === 'quickjs') {
  const m = await import('@mikrojs/quickjs')
  process.stdout.write(m.cmakePath)
} else if (query === 'native') {
  const n = await import('@mikrojs/native/cmake')
  process.stdout.write(
    JSON.stringify({
      include: n.includePath,
      src: n.srcPath,
      runtime: n.runtimePath,
      scripts: n.scriptsPath,
      bytecodeCmake: n.bytecodeCmakePath,
    }),
  )
} else if (query === 'version') {
  const {default: pkg} = await import('./package.json', {with: {type: 'json'}})
  process.stdout.write(pkg.version)
} else if (query === 'discover') {
  const projectDir = process.argv[3]
  const {discover} = await import('./discover.js')
  process.stdout.write(JSON.stringify(discover(projectDir)))
} else {
  process.stderr.write(`Unknown query: ${query}\n`)
  process.exit(1)
}
