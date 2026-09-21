import {dirname, resolve, sep} from 'node:path'

import analyze, {type ImportRef} from './analyze.js'
import {type FileSystem, realpath} from './fs.js'
import resolveDependency, {NotFoundError, type ResolveContext} from './resolve.js'

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
  /** True for a specifier the firmware provides. */
  isExternal: (specifier: string) => boolean
  /** Files with these extensions deploy, but are not parsed. */
  assetExtensions: string[]
}

interface Pjson {
  name?: unknown
  version?: unknown
  type?: unknown
}

export async function discover(entries: string[], options: DiscoverOptions): Promise<Graph> {
  const {fs, isExternal, assetExtensions} = options
  const ctx: ResolveContext = {
    fs,
    conditions: options.conditions,
    ts: true,
    base: options.root,
  }
  const graph: Graph = {modules: new Map(), packages: new Map(), problems: []}

  const pjsons = new Map<string, Promise<Pjson | undefined>>()
  function readPjson(dir: string) {
    let pjson = pjsons.get(dir)
    if (pjson === undefined) {
      pjson = fs.readFile(dir + sep + 'package.json').then((source) => {
        if (source === undefined) return undefined
        try {
          return JSON.parse(source) as Pjson
        } catch {
          return {}
        }
      })
      pjsons.set(dir, pjson)
    }
    return pjson
  }

  // The nearest package.json decides the module type. The nearest one with a
  // name is the package: a nameless one only marks a directory as ESM.
  async function packageOf(file: string) {
    let type: unknown
    let hasPjson = false
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      const pjson = await readPjson(dir)
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
      if (specifier.endsWith('.js') && error instanceof NotFoundError) {
        return resolveDependency(specifier.slice(0, -3) + '.ts', parent, ctx)
      }
      throw error
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
      if (isExternal(ref.specifier)) {
        module.imports.push({...ref, target: {type: 'external'}})
        continue
      }
      let resolved: string
      try {
        // Node resolves from the real path.
        resolved = await resolveFrom(ref.specifier, path)
      } catch (error) {
        // A linked package can import what only the app depends on. Node does
        // not find it from the package's real path, but does from the path the
        // package was reached at.
        try {
          if (reachedAt === path) throw error
          resolved = await resolveFrom(ref.specifier, reachedAt)
        } catch {
          const message = error instanceof Error ? error.message : String(error)
          graph.problems.push(`Failed to resolve dependency "${ref.specifier}":\n${message}`)
          module.imports.push({...ref, target: {type: 'unresolved'}})
          continue
        }
      }
      const target = await realpath(fs, resolved)
      module.imports.push({...ref, target: {type: 'file', path: target}})
      queue.push({path: target, reachedAt: resolved})
    }
  }

  return graph
}
