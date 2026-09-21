import {posix, relative, sep} from 'node:path'

import type {Graph, TracedModule} from './discover.js'
import type {DuplicatePackage} from './types.js'

/** Replaces `[start, end)` of a file's source with `text`. */
export interface Rewrite {
  start: number
  end: number
  text: string
}

export interface DeployedFile {
  /** Real path to read the file from. */
  source: string
  /** Import specifiers to replace so the device loads them by relative path. */
  rewrites: Rewrite[]
}

export interface Layout {
  /** Keyed by the path the file deploys to: relative to the app, `/` separated. */
  files: Map<string, DeployedFile>
  /** Builtin specifiers. `dynamic` when no file imports it statically. */
  externals: Map<string, 'static' | 'dynamic'>
  duplicatePackages: DuplicatePackage[]
  problems: string[]
}

const NODE_MODULES = sep + 'node_modules' + sep

function inDir(path: string, dir: string) {
  return path.startsWith(dir + sep)
}

// TypeScript deploys as the JavaScript it is stripped to.
function outputName(path: string) {
  return path.endsWith('.ts') ? path.slice(0, -3) + '.js' : path
}

/**
 * Where every file of the graph deploys. The device loads each import by the
 * relative path written into the importer, so nothing has to be found by a walk
 * up node_modules: an app file keeps its path, and a package gets one directory
 * under node_modules, however many paths it was reached at.
 */
export function layout(graph: Graph, root: string): Layout {
  const problems = [...graph.problems]

  const isAppFile = (path: string) => inDir(path, root) && !path.includes(NODE_MODULES)

  // One directory per package in use. A name used by one package directory is
  // the directory name. Several get `name@version`, in real path order, with
  // a counter when that is taken too.
  const usedPackages = new Set<string>()
  for (const module of graph.modules.values()) {
    if (!isAppFile(module.path) && module.package !== undefined) usedPackages.add(module.package)
  }
  const dirsByName = new Map<string, string[]>()
  for (const dir of [...usedPackages].sort()) {
    const {name} = graph.packages.get(dir)!
    dirsByName.set(name, [...(dirsByName.get(name) ?? []), dir])
  }
  const deployDirs = new Map<string, string>()
  const duplicatePackages: DuplicatePackage[] = []
  for (const [name, dirs] of [...dirsByName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const taken = new Set<string>()
    const copies = dirs.map((dir) => {
      const {version} = graph.packages.get(dir)!
      const base = dirs.length === 1 || version === undefined ? name : `${name}@${version}`
      let deployName = base
      for (let n = 2; taken.has(deployName); n++) deployName = `${base}_${n}`
      taken.add(deployName)
      const path = 'node_modules/' + deployName
      deployDirs.set(dir, path)
      return version === undefined ? {path} : {path, version}
    })
    if (copies.length > 1) duplicatePackages.push({name, copies})
  }

  function deployPath(module: TracedModule): string | undefined {
    if (isAppFile(module.path)) {
      return outputName(relative(root, module.path).split(sep).join('/'))
    }
    if (module.package === undefined) return undefined
    const inPackage = relative(module.package, module.path).split(sep).join('/')
    // The device finds a package by name through node_modules/<dir>/package.json.
    // A deployed package must not be importable that way, so its own
    // package.json deploys under another name.
    const name = inPackage === 'package.json' ? '_package.json' : outputName(inPackage)
    return deployDirs.get(module.package) + '/' + name
  }

  const paths = new Map<string, string>()
  const files = new Map<string, DeployedFile>()
  for (const module of graph.modules.values()) {
    const path = deployPath(module)
    if (path === undefined) continue
    const other = files.get(path)
    if (other !== undefined) {
      problems.push(
        `Cannot deploy "${module.path}" and "${other.source}": both deploy to "${path}"`,
      )
      continue
    }
    paths.set(module.path, path)
    files.set(path, {source: module.path, rewrites: []})
  }

  const externals = new Map<string, 'static' | 'dynamic'>()
  for (const module of graph.modules.values()) {
    const from = paths.get(module.path)
    for (const ref of module.imports) {
      if (ref.target.type === 'external') {
        if (externals.get(ref.specifier) !== 'static') externals.set(ref.specifier, ref.kind)
        continue
      }
      if (ref.target.type !== 'file' || from === undefined) continue

      const to = paths.get(ref.target.path)
      const target = graph.modules.get(ref.target.path)!
      const relativeImport = ref.specifier.startsWith('.')
      // A relative import that leaves the app, or the importer's package, points
      // at a file that belongs to nothing the build deploys.
      const leaves = isAppFile(module.path)
        ? !isAppFile(target.path)
        : isAppFile(target.path) || target.package !== module.package
      if (to === undefined || (relativeImport && leaves)) {
        const shown = relative(root, ref.target.path).split(sep).join('/')
        problems.push(
          `Cannot deploy "${shown}", imported from "${from}": it is outside ` +
            (isAppFile(module.path) ? 'the app directory' : 'its package'),
        )
        continue
      }

      let text = posix.relative(posix.dirname(from), to)
      if (!text.startsWith('.')) text = './' + text
      if (text === ref.specifier) continue
      if (ref.range === undefined) {
        problems.push(
          `Cannot deploy import("${ref.specifier}") in "${from}": the specifier is computed, ` +
            `so the build cannot point it at "${to}". Use a string literal.`,
        )
        continue
      }
      files.get(from)!.rewrites.push({start: ref.range[0], end: ref.range[1], text})
    }
  }

  return {files, externals, duplicatePackages, problems}
}
