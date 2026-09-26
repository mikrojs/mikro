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
 *   projectName <dir> — package.json name of the consuming project (empty if none)
 *   inputs <dir> [--native-modules=<a;b>]
 *                    — resolve the declared native modules (see inputs.js)
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
} else if (query === 'projectName') {
  const {readFileSync} = await import('node:fs')
  const {join} = await import('node:path')
  try {
    const pkg = JSON.parse(readFileSync(join(process.argv[3], 'package.json'), 'utf8'))
    if (typeof pkg.name === 'string') process.stdout.write(pkg.name)
  } catch {
    // No package.json (e.g. on-device test apps): no identity, empty output.
  }
} else if (query === 'inputs') {
  const projectDir = process.argv[3]
  let nativeModules = []
  for (const arg of process.argv.slice(4)) {
    if (arg.startsWith('--native-modules=')) {
      nativeModules = arg.slice('--native-modules='.length).split(';').filter(Boolean)
    }
  }
  const {resolveFirmwareInputs} = await import('./inputs.js')
  try {
    process.stdout.write(JSON.stringify(await resolveFirmwareInputs(projectDir, {nativeModules})))
  } catch (e) {
    // Manifest errors are complete messages for the CMake FATAL_ERROR; anything
    // else is a bug worth a stack trace.
    process.stderr.write(e.name === 'ManifestError' ? `${e.message}\n` : `${e.stack}\n`)
    process.exit(1)
  }
} else {
  process.stderr.write(`Unknown query: ${query}\n`)
  process.exit(1)
}
