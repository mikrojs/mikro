/**
 * Resolve a firmware project's native modules to build inputs.
 *
 * Nothing is inferred from what is installed: the project's CMakeLists.txt
 * lists the native modules to compile in (MIKROJS_NATIVE_MODULES), by the
 * import specifier apps use. Each resolves to a package export whose `native`
 * condition points at C/C++ source, and the source's directory is added as an
 * ESP-IDF component.
 *
 * The files read on the way are returned too, so CMake re-runs this when one
 * of them changes.
 *
 * Run by project.cmake via `node resolve.js inputs <dir> --native-modules=…`.
 */
import {existsSync, readFileSync} from 'node:fs'
import {basename, join, resolve} from 'node:path'

import {findPackageDir, ManifestError, packageNameOf, resolveNativeModule} from './manifest.js'

/** Components every firmware already has (see project.cmake). */
const RESERVED_COMPONENTS = ['main', 'mikrojs']

/** sdkconfig defaults of the MIKROJS_BOARD board from `mikrojs.boards` in the
 *  project's dependencies. */
function boardSdkconfigs(projectDir) {
  const packageJson = join(projectDir, 'package.json')
  if (!existsSync(packageJson)) return []
  const project = JSON.parse(readFileSync(packageJson, 'utf8'))
  const board = process.env.MIKROJS_BOARD ?? ''
  const sdkconfigs = []
  for (const dep of Object.keys(project.dependencies ?? {})) {
    const depDir = findPackageDir(dep, projectDir)
    if (!depDir) continue
    const file = join(depDir, 'package.json')
    let depPkg
    try {
      depPkg = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new ManifestError(`cannot read ${file}: ${e.message}`, {cause: e})
    }
    for (const [subpath, config] of Object.entries(depPkg.mikrojs?.boards ?? {})) {
      const boardName = subpath.startsWith('./') ? subpath.slice(2) : subpath
      if ((!board || board === boardName) && config.sdkconfig) {
        sdkconfigs.push(resolve(depDir, config.sdkconfig))
      }
    }
  }
  return sdkconfigs
}

/**
 * @param {string} projectDir - Directory containing the firmware project
 * @param {{nativeModules?: string[]}} declared - MIKROJS_NATIVE_MODULES
 * @returns {Promise<{components: string, nativeModules: string, sdkconfigs: string, configureDepends: string}>}
 *   Semicolon-separated CMake lists; empty strings where nothing applies
 */
export async function resolveFirmwareInputs(projectDir, {nativeModules: declared = []} = {}) {
  /** Files whose change can change the result. */
  const configureDepends = new Set([join(projectDir, 'package.json')])
  /** @type {{label: string, dir: string}[]} */
  const components = []
  const specifiers = new Set()

  for (const specifier of declared) {
    const pkg = packageNameOf(specifier)
    const packageDir = findPackageDir(pkg, projectDir)
    if (!packageDir) {
      throw new ManifestError(
        `MIKROJS_NATIVE_MODULES names "${specifier}", but no package "${pkg}" is ` +
          `installed (searched from ${projectDir})`,
      )
    }
    configureDepends.add(join(packageDir, 'package.json'))
    const nativeModule = resolveNativeModule(specifier, projectDir)
    if (!nativeModule) {
      throw new ManifestError(
        `MIKROJS_NATIVE_MODULES names "${specifier}", which is not a native module: ` +
          `${pkg} has no export for it whose "native" condition points at C/C++ source`,
      )
    }
    specifiers.add(specifier)
    const name = basename(nativeModule.dir)
    // Two exports whose sources share a directory are one component.
    if (components.some((c) => c.dir === nativeModule.dir)) continue
    // ESP-IDF names a component after its directory and silently skips a
    // second one with the same name, so a clash has to fail here.
    if (RESERVED_COMPONENTS.includes(name)) {
      throw new ManifestError(
        `native module ${nativeModule.label} has a component named "${name}" ` +
          `(${nativeModule.dir}); the firmware has its own component of that name, so ` +
          'rename the directory',
      )
    }
    const clash = components.find((c) => basename(c.dir) === name)
    if (clash) {
      throw new ManifestError(
        `native modules ${clash.label} and ${nativeModule.label} both have a component named "${name}" ` +
          `(${clash.dir}, ${nativeModule.dir}); ESP-IDF names components after their ` +
          'directory, so the names must differ',
      )
    }
    components.push({label: nativeModule.label, dir: nativeModule.dir})
  }

  return {
    components: components.map((c) => c.dir).join(';'),
    nativeModules: [...specifiers].sort().join(';'),
    sdkconfigs: boardSdkconfigs(projectDir).join(';'),
    configureDepends: [...configureDepends].filter((file) => existsSync(file)).join(';'),
  }
}
