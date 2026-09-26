import {dirname, join, relative, resolve} from 'node:path'

import analyze, {type ImportRef} from './analyze.js'
import {type FileSystem, realpath} from './fs.js'
import resolveDependency, {NotFoundError, readPackageJson, type ResolveContext} from './resolve.js'

/** A directory with a package.json that has a name. */
export interface TracedPackage {
  /** Real path. */
  dir: string
  name: string
  version?: string
}

export type ImportTarget =
  /** `path` is the real path of a module in the graph. */
  | {type: 'file'; path: string}
  /** Provided by the firmware; nothing to deploy. */
  | {type: 'external'}
  /** Reported in `problems`. */
  | {type: 'unresolved'}

export interface TracedImport extends ImportRef {
  target: ImportTarget
}

export interface TracedModule {
  /** Real path. */
  path: string
  /** `dir` of the nearest package above the file, if any. */
  package?: string
  imports: TracedImport[]
}

// A specifier that names a package, not a path or a `#` import of the importer's own.
function isBare(specifier: string) {
  return !specifier.startsWith('.') && !specifier.startsWith('#') && !specifier.startsWith('/')
}

/** Every file the entries reach, keyed by real path, in the order found. */
export interface Graph {
  modules: Map<string, TracedModule>
  packages: Map<string, TracedPackage>
  problems: string[]
}

export interface DiscoverOptions {
  fs: FileSystem
  /** The app directory. */
  root: string
  conditions: string[]
  /** True for a specifier the firmware provides. `importer` is the real path
   *  of the importing file, then, for a file reached through a link, the path it
   *  was reached at. */
  isExternal: (specifier: string, importer: string) => boolean
  /** Files with these extensions deploy, but are not parsed. */
  assetExtensions: string[]
}

export async function discover(entries: string[], options: DiscoverOptions): Promise<Graph> {
  const {fs, isExternal, assetExtensions} = options
  const ctx: ResolveContext = {
    fs,
    conditions: options.conditions,
    ts: true,
    base: options.root,
    packageJsons: new Map(),
  }
  const graph: Graph = {modules: new Map(), packages: new Map(), problems: []}

  // The nearest package.json decides the module type. The nearest one with a
  // name is the package: a nameless one only marks a directory as ESM.
  async function packageOf(file: string) {
    let type: unknown
    let hasPjson = false
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      const pjson = await readPackageJson(dir, ctx)
      if (pjson !== undefined) {
        if (!hasPjson) type = pjson.type
        hasPjson = true
        if (typeof pjson.name === 'string') {
          if (!graph.packages.has(dir)) {
            const version = typeof pjson.version === 'string' ? {version: pjson.version} : {}
            graph.packages.set(dir, {dir, name: pjson.name, ...version})
          }
          return {dir, name: pjson.name, type, hasPjson}
        }
      }
      if (dir === dirname(dir)) return {type, hasPjson}
    }
  }

  async function resolveFrom(specifier: string, parent: string) {
    try {
      return await resolveDependency(specifier, parent, ctx)
    } catch (error) {
      // TypeScript sources import `./x.js` for a file that is `./x.ts` on disk.
      if (!specifier.endsWith('.js') || !(error instanceof NotFoundError)) throw error
      try {
        return await resolveDependency(specifier.slice(0, -3) + '.ts', parent, ctx)
      } catch {
        // Report the specifier the file has, not the one tried here.
        throw error
      }
    }
  }

  // One at a time, in import order: the graph must not depend on I/O timing.
  const queue: {path: string; reachedAt: string}[] = []
  for (const entry of entries) {
    const reachedAt = resolve(entry)
    if ((await fs.stat(reachedAt)) !== 'file') {
      graph.problems.push(`Cannot find entry "${entry}"`)
      continue
    }
    queue.push({path: await realpath(fs, reachedAt), reachedAt})
  }

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const {path, reachedAt} = next
    if (graph.modules.has(path)) continue
    const pkg = await packageOf(path)
    const module: TracedModule = {
      path,
      ...(pkg.dir === undefined ? {} : {package: pkg.dir}),
      imports: [],
    }
    graph.modules.set(path, module)

    if (path.endsWith('.json') || assetExtensions.some((ext) => path.endsWith(ext))) continue
    if (pkg.hasPjson && pkg.type !== 'module') {
      graph.problems.push(`Non-ESM dependency detected: ${pkg.name ?? path}`)
      continue
    }

    const source = await fs.readFile(path)
    if (source === undefined) throw new Error('File ' + path + ' does not exist.')
    const {imports, parseError} = await analyze(path, source)
    if (parseError !== undefined) graph.problems.push(parseError)

    for (const ref of imports) {
      // Asked from both places the specifier may resolve from, see below.
      if (
        isExternal(ref.specifier, path) ||
        (reachedAt !== path && isExternal(ref.specifier, reachedAt))
      ) {
        module.imports.push({...ref, target: {type: 'external'}})
        continue
      }
      // Node resolves from the real path. A linked package can also import what
      // only the app depends on: that fails from the package's real path, and
      // resolves from the path the file was reached at, through the app's
      // node_modules. The device resolved from there before imports were rewritten.
      let resolved: string | undefined
      let from = path
      let failure: unknown
      try {
        resolved = await resolveFrom(ref.specifier, path)
      } catch (error) {
        failure = error
      }
      if (resolved === undefined && reachedAt !== path) {
        try {
          resolved = await resolveFrom(ref.specifier, reachedAt)
          from = reachedAt
        } catch {
          // Reported below, with the error from the real path.
        }
      }
      if (resolved === undefined) {
        const message = failure instanceof Error ? failure.message : String(failure)
        graph.problems.push(`Failed to resolve dependency "${ref.specifier}":\n${message}`)
        module.imports.push({...ref, target: {type: 'unresolved'}})
        continue
      }
      const target = await realpath(fs, resolved)
      module.imports.push({...ref, target: {type: 'file', path: target}})
      // A file found next to its importer was reached next to where the importer was.
      const inReachedTree = from === path && reachedAt !== path && !isBare(ref.specifier)
      queue.push({
        path: target,
        reachedAt: inReachedTree
          ? join(dirname(reachedAt), relative(dirname(path), resolved))
          : resolved,
      })
    }
  }

  return graph
}
