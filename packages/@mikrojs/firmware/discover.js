/**
 * Discover ESP-IDF components and board sdkconfig defaults from
 * a firmware project's dependencies.
 *
 * Can be used as a module (import {discover} from '@mikrojs/firmware/discover')
 * or run directly via node (reads cwd).
 */
import {readFileSync, existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join, resolve} from 'node:path'

/** Find a package's directory by walking up node_modules from startDir */
function findPackageDir(name, startDir) {
  let dir = startDir
  while (true) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Scan dependencies in the given project directory for ESP-IDF components
 * and board sdkconfig defaults.
 *
 * @param {string} projectDir - Directory containing package.json
 * @returns {{components: string, sdkconfigs: string}} Semicolon-separated paths
 */
export function discover(projectDir) {
  /* Firmware projects without a package.json (e.g. bare test apps) have no
   * dependencies to scan. */
  if (!existsSync(join(projectDir, 'package.json'))) {
    return {components: '', sdkconfigs: ''}
  }
  const require = createRequire(join(projectDir, 'package.json'))
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
  const dependencies = pkg.dependencies ?? {}
  const board = process.env.MIKROJS_BOARD ?? ''
  const components = []
  const sdkconfigs = []

  for (const dep of Object.keys(dependencies)) {
    if (dep === '@mikrojs/native' || dep === '@mikrojs/quickjs' || dep === '@mikrojs/firmware')
      continue

    const depDir = findPackageDir(dep, projectDir)
    if (!depDir) continue

    // Check for cmake component exports (cmake.js files use CJS)
    let cmake
    try {
      cmake = require(dep + '/cmake')
    } catch {
      continue
    }

    if (cmake.componentPath) components.push(cmake.componentPath)
    if (Array.isArray(cmake.componentPaths)) components.push(...cmake.componentPaths)

    // Read board-specific sdkconfig from mikrojs.boards manifest
    try {
      const depPkg = JSON.parse(readFileSync(join(depDir, 'package.json'), 'utf8'))
      if (depPkg.mikrojs?.boards) {
        for (const [subpath, config] of Object.entries(depPkg.mikrojs.boards)) {
          const boardName = subpath.startsWith('./') ? subpath.slice(2) : subpath
          if ((!board || board === boardName) && config.sdkconfig) {
            sdkconfigs.push(resolve(depDir, config.sdkconfig))
          }
        }
      }
    } catch {
      // No board manifest
    }
  }

  return {
    components: components.join(';'),
    sdkconfigs: sdkconfigs.join(';'),
  }
}
