import {posix, relative, sep} from 'node:path'

import type {Graph, TracedModule} from './discover.js'
import type {DuplicatePackage} from './types.js'

/** Replaces `[start, end)` of a file's source with `text`. */
export interface Rewrite {
  start: number
  end: number
  text: string
}

export interface SourceFile {
  /** Real path to read the file from. */
  source: string
  /** Import specifiers to replace so the device loads them by relative path. */
  rewrites: Rewrite[]
}

/** A file the layout writes itself: a package's deployed package.json. */
export interface GeneratedFile {
  contents: string
}

export type DeployedFile = SourceFile | GeneratedFile

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
 *
 * `deployDir` is the directory, relative to `root`, that becomes the root of the
 * device's file system. A file outside it deploys inside it, at its path
 * relative to `root`: with `app`, `node_modules/a/x.js` deploys at
 * `app/node_modules/a/x.js`.
 */
export function layout(graph: Graph, root: string, deployDir = '.'): Layout {
  const problems = [...graph.problems]

  // Only what follows `root` counts: the app may itself sit under a node_modules.
  const isAppFile = (path: string) =>
    inDir(path, root) && !path.slice(root.length).includes(NODE_MODULES)
  const inDeployDir = (path: string) =>
    deployDir === '.' || path.startsWith(deployDir + '/') ? path : deployDir + '/' + path

  // One directory per package in use. A name used by one package directory is
  // the directory name. When several use it, the copy that the app's own files
  // import keeps the name, and the others get `name@version`, in real path order,
  // with a counter when that is taken too.
  const usedPackages = new Set<string>()
  const importedByApp = new Map<string, Set<string>>()
  for (const module of graph.modules.values()) {
    if (!isAppFile(module.path)) {
      if (module.package !== undefined) usedPackages.add(module.package)
      continue
    }
    for (const ref of module.imports) {
      if (ref.target.type !== 'file') continue
      const dir = graph.modules.get(ref.target.path)?.package
      if (dir === undefined) continue
      const {name} = graph.packages.get(dir)!
      // By its own name only: an alias is not a name the package can be found by.
      if (ref.specifier !== name && !ref.specifier.startsWith(name + '/')) continue
      importedByApp.set(name, (importedByApp.get(name) ?? new Set()).add(dir))
    }
  }
  const dirsByName = new Map<string, string[]>()
  for (const dir of [...usedPackages].sort()) {
    const {name} = graph.packages.get(dir)!
    dirsByName.set(name, [...(dirsByName.get(name) ?? []), dir])
  }
  const deployDirs = new Map<string, string>()
  // Packages that deploy under their plain name. Those stay importable by name.
  const namedPackages = new Map<string, string>()
  const duplicatePackages: DuplicatePackage[] = []
  for (const [name, dirs] of [...dirsByName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // App files in different directories can resolve one name to two copies.
    // Then no copy is "the app's".
    const byApp = importedByApp.get(name)
    const named = dirs.length === 1 ? dirs[0] : byApp?.size === 1 ? [...byApp][0] : undefined
    if (named !== undefined) namedPackages.set(named, name)
    const taken = new Set(named === undefined ? [] : [name])
    const copies = dirs.map((dir) => {
      const {version} = graph.packages.get(dir)!
      let deployName = name
      if (dir !== named) {
        const base = version === undefined ? name : `${name}@${version}`
        deployName = base
        for (let n = 2; taken.has(deployName); n++) deployName = `${base}_${n}`
        taken.add(deployName)
      }
      const path = inDeployDir('node_modules/' + deployName)
      deployDirs.set(dir, path)
      return version === undefined ? {path} : {path, version}
    })
    if (copies.length > 1) duplicatePackages.push({name, copies})
  }

  function deployPath(module: TracedModule): string | undefined {
    if (isAppFile(module.path)) {
      return inDeployDir(outputName(relative(root, module.path).split(sep).join('/')))
    }
    if (module.package === undefined) return undefined
    const inPackage = relative(module.package, module.path).split(sep).join('/')
    // The device finds a package by name through node_modules/<dir>/package.json.
    // That path is for the package.json the layout writes (or leaves out), so
    // the package's own deploys under another name.
    const name = inPackage === 'package.json' ? '_package.json' : outputName(inPackage)
    return deployDirs.get(module.package) + '/' + name
  }

  const paths = new Map<string, string>()
  const files = new Map<string, SourceFile>()
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

  // Per named package, the subpaths the app imports it by and the file each
  // one resolved to.
  const exportsOf = new Map<string, Map<string, string>>()
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

      const name = target.package === undefined ? undefined : namedPackages.get(target.package)
      if (name !== undefined && (ref.specifier === name || ref.specifier.startsWith(name + '/'))) {
        const exports = exportsOf.get(target.package!) ?? new Map<string, string>()
        exportsOf.set(target.package!, exports)
        const dir = deployDirs.get(target.package!)!
        exports.set('.' + ref.specifier.slice(name.length), './' + posix.relative(dir, to))
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

  // Rewritten imports never look a package up, but the REPL and files written
  // on the device do. A package that is the only one with its name gets a
  // package.json that maps the imported subpaths to the deployed files. A
  // `name@version` directory gets none, so it cannot be imported by name.
  const deployed = new Map<string, DeployedFile>(files)
  for (const [dir, exports] of exportsOf) {
    const sorted = Object.fromEntries([...exports].sort(([a], [b]) => (a < b ? -1 : 1)))
    deployed.set(deployDirs.get(dir) + '/package.json', {
      contents: JSON.stringify({exports: sorted}),
    })
  }

  return {files: deployed, externals, duplicatePackages, problems}
}
