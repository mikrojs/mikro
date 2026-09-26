/**
 * Resolver of native modules from package manifests (package.json).
 *
 * A native module (C/C++ the firmware must carry: a driver, or any other
 * native code) has no manifest of its own. It is a package export whose
 * `native` condition targets a C/C++ source file, with a `types` condition for
 * TypeScript and, optionally, a `default` that host tools (tests, the
 * simulator) load instead:
 *   "./sh8601": {"types": "./sh8601/sh8601.d.ts", "native": "./sh8601/sh8601.cpp"}
 * The source file's directory is the ESP-IDF component (see inputs.js).
 */
import {existsSync, readFileSync} from 'node:fs'
import {basename, dirname, join, relative, resolve} from 'node:path'

export class ManifestError extends Error {
  name = 'ManifestError'
}

function check(condition, message) {
  if (!condition) throw new ManifestError(message)
}

/** The package an import specifier names: `@scope/name` or `name`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

/** Directory of an installed package, walking node_modules up from fromDir. */
export function findPackageDir(name, fromDir) {
  let dir = resolve(fromDir)
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Root of the package containing `file` (nearest package.json upwards). */
function findPackageRoot(file) {
  let dir = dirname(file)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

/** The C/C++ source an export's `native` condition targets, or undefined. */
function nativeTarget(value) {
  return typeof value === 'object' && value !== null && typeof value.native === 'string'
    ? value.native
    : undefined
}

const NATIVE_SOURCE_RE = /\.(c|cc|cpp|cxx)$/

/** Whether `file` is C/C++ source: the target of a native module's export. */
export function isNativeSource(file) {
  return NATIVE_SOURCE_RE.test(file)
}

/**
 * The native module whose export target is the C/C++ source `file`: its
 * directory is the ESP-IDF component, labelled `<package>[/<dir in package>]`.
 */
export function nativeModuleOf(file) {
  const dir = dirname(file)
  const packageDir = findPackageRoot(file)
  check(packageDir, `native module ${file}: no package.json above it`)
  const packageName = readPackageJson(packageDir).name
  const inPackage = relative(packageDir, dir)
  const label = inPackage ? `${packageName}/${inPackage}` : packageName
  check(
    existsSync(join(dir, 'CMakeLists.txt')),
    `native module ${label}: ${dir} has no CMakeLists.txt; the directory of ${basename(file)} must be an ESP-IDF component`,
  )
  return {name: basename(dir), label, file, dir}
}

/**
 * The native module a bare import specifier names, resolved from `fromDir`:
 * the package's export for that subpath targets C/C++ source. Undefined for
 * anything else (JS modules, packages that are not installed).
 */
export function resolveNativeModule(specifier, fromDir) {
  if (!/^(@[^/]+\/)?[^./@][^/]*(\/|$)/.test(specifier)) return undefined
  const packageName = packageNameOf(specifier)
  // A package may import itself by name (Node's self-reference).
  const ownDir = findPackageRoot(join(fromDir, 'x'))
  const packageDir =
    ownDir && readPackageJson(ownDir).name === packageName
      ? ownDir
      : findPackageDir(packageName, fromDir)
  if (!packageDir) return undefined
  const subpath = specifier.slice(packageName.length + 1)
  const target = nativeTarget(readPackageJson(packageDir).exports?.[subpath ? `./${subpath}` : '.'])
  if (target === undefined || !isNativeSource(target)) return undefined
  return nativeModuleOf(join(packageDir, target))
}
