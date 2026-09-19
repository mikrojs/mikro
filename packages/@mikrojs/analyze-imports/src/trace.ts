import {matchesGlob} from 'node:path'

import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'path'

import analyze, {type AnalyzeResult} from './analyze.js'
import {CachedFileSystem} from './fs.js'
import resolveDependency, {NotFoundError} from './resolve.js'
import type {
  DuplicatePackage,
  NodeFileTraceOptions,
  NodeFileTraceReasons,
  NodeFileTraceReasonType,
  NodeFileTraceResult,
} from './types.js'

function inPath(path: string, parent: string) {
  const pathWithSep = join(parent, sep)
  return path.startsWith(pathWithSep) && path !== pathWithSep
}

export async function nodeFileTrace(
  files: string[],
  opts: NodeFileTraceOptions = {},
): Promise<NodeFileTraceResult> {
  const job = new Tracer(opts)

  if (opts.readFile) job.readFile = opts.readFile
  if (opts.stat) job.stat = opts.stat
  if (opts.readlink) job.readlink = opts.readlink
  if (opts.resolve) job.resolve = opts.resolve

  job.ts = true

  await Promise.all(
    files.map(async (file) => {
      const path = resolve(file)
      await job.emitFile(path, 'initial')
      return job.emitDependency(path)
    }),
  )

  await job.verifyPlacements()
  await hoistDuplicatePackages(job)
  const duplicatePackages = await findDuplicatePackages(job)

  // Build source path map: for files in the fileList that have virtual paths,
  // map the relative output path to the real source path on disk
  const sourcePathMap = new Map<string, string>()
  for (const file of job.fileList) {
    const absPath = resolve(job.base, file)
    const realPath = job.virtualPathToRealPath.get(absPath)
    if (realPath) {
      sourcePathMap.set(file, realPath)
    }
  }

  return {
    fileList: job.fileList,
    reasons: job.reasons,
    warnings: job.warnings,
    duplicatePackages,
    sourcePathMap,
  }
}

// Extract the package name from a path segment after node_modules/
// e.g. "pretty-ms/index.js" -> "pretty-ms", "@scope/pkg/index.js" -> "@scope/pkg"
function getPkgNameFromPath(pathAfterNodeModules: string) {
  const segments = pathAfterNodeModules.split(sep)
  if (segments[0]![0] === '@' && segments.length > 1) return segments.slice(0, 2).join(sep)
  return segments[0]!
}

const NODE_MODULES = sep + 'node_modules' + sep

// The package directory (`<dir>/node_modules/<name>`) a traced file sits in.
function packageDirOf(file: string): string | undefined {
  const path = sep + file
  const idx = path.lastIndexOf(NODE_MODULES)
  if (idx === -1) return undefined
  const name = getPkgNameFromPath(path.slice(idx + NODE_MODULES.length))
  return path.slice(1, idx + NODE_MODULES.length) + name
}

// Dedupes a package that the trace reached at two node_modules paths.
//
// A linked package (a workspace member) has its own node_modules, so it reaches
// a dependency at a nested path. When the app reaches the same directory on disk
// at an outer path too, the deploy would carry the package twice, and the device
// would load it as two module instances.
//
// The nested files move to the outer path. That is where the device's walk up
// from the importer ends once the nested copy is gone. A copy in a different
// directory on disk (another version) is left alone.
async function hoistDuplicatePackages(job: Tracer) {
  const realDirOf = async (pkgDir: string, files: string[]) => {
    const file = files[0]!
    const real = await job.realpath(resolve(job.base, file))
    const tail = file.slice(pkgDir.length)
    return real.endsWith(tail) ? real.slice(0, -tail.length) : undefined
  }

  for (let moved = true; moved;) {
    moved = false
    const packages = new Map<string, string[]>()
    for (const file of job.fileList) {
      const pkgDir = packageDirOf(file)
      if (pkgDir === undefined) continue
      const files = packages.get(pkgDir)
      if (files) files.push(file)
      else packages.set(pkgDir, [file])
    }

    // Deepest first, then by name: the trace fills fileList in timing order, and
    // the result must not depend on it.
    const depth = (dir: string) => (sep + dir).split(NODE_MODULES).length
    const ordered = [...packages].sort(
      ([x], [y]) => depth(y) - depth(x) || (x < y ? -1 : x > y ? 1 : 0),
    )
    for (const [nested, files] of ordered) {
      const path = sep + nested
      const idx = path.lastIndexOf(NODE_MODULES)
      const name = path.slice(idx + NODE_MODULES.length)
      // The nearest outer copy is the one the device finds.
      let outer: string | undefined
      for (let dir = path.slice(0, idx); dir !== '' && outer === undefined;) {
        dir = dir.slice(0, dir.lastIndexOf(sep))
        const candidate = (dir + NODE_MODULES + name).slice(1)
        if (packages.has(candidate)) outer = candidate
      }
      if (outer === undefined) continue
      const nestedReal = await realDirOf(nested, files)
      if (nestedReal === undefined) continue
      if (nestedReal !== (await realDirOf(outer, packages.get(outer)!))) continue

      // A dependency the nested copy found in a node_modules between the two
      // paths is out of reach from the outer one: leave such a package nested.
      const reachesOutOfSight = [...job.reasons].some(([file, reason]) => {
        if (file.startsWith(nested + sep)) return false
        const dependency = packageDirOf(file)
        if (dependency === undefined) return false
        const dependencyPath = sep + dependency
        const owner = dependencyPath.slice(0, dependencyPath.lastIndexOf(NODE_MODULES))
        if ((sep + outer).startsWith(owner + sep)) return false
        return [...reason.parents].some((parent) => parent.startsWith(nested + sep))
      })
      if (reachesOutOfSight) continue

      // Everything under the nested directory moves, its own node_modules too:
      // the package's dependencies have to stay where it finds them.
      const rename = (path: string) =>
        path.startsWith(nested + sep) ? outer + path.slice(nested.length) : path
      const moving = [...job.fileList].filter((file) => file.startsWith(nested + sep))
      for (const file of moving) {
        const target = rename(file)
        const real = await job.realpath(resolve(job.base, file))
        job.fileList.delete(file)
        const reason = job.reasons.get(file)
        job.reasons.delete(file)
        if (job.fileList.has(target)) {
          for (const parent of reason?.parents ?? []) job.reasons.get(target)?.parents.add(parent)
          continue
        }
        job.fileList.add(target)
        if (reason) job.reasons.set(target, reason)
        job.virtualPathToRealPath.set(resolve(job.base, target), real)
      }
      // The guard above reads parents, so they have to follow the move.
      for (const reason of job.reasons.values()) {
        reason.parents = new Set([...reason.parents].map(rename))
      }
      moved = true
      break
    }
  }
}

// What the hoist could not merge: a package name with more than one package
// directory in fileList, whether the copies are one package on disk or two.
async function findDuplicatePackages(job: Tracer): Promise<DuplicatePackage[]> {
  const dirsByName = new Map<string, Set<string>>()
  for (const file of job.fileList) {
    const dir = packageDirOf(file)
    if (dir === undefined) continue
    const path = sep + dir
    const name = path.slice(path.lastIndexOf(NODE_MODULES) + NODE_MODULES.length)
    const dirs = dirsByName.get(name)
    if (dirs) dirs.add(dir)
    else dirsByName.set(name, new Set([dir]))
  }

  const duplicates: DuplicatePackage[] = []
  for (const [name, dirs] of dirsByName) {
    if (dirs.size < 2) continue
    const copies = await Promise.all(
      [...dirs].sort().map(async (path) => {
        // Through job.readFile, so a pnpm virtual path reads its real file.
        const pjson = await job.readFile(resolve(job.base, path, 'package.json'))
        const version = pjson === null ? undefined : JSON.parse(pjson.toString()).version
        return typeof version === 'string' ? {path, version} : {path}
      }),
    )
    duplicates.push({name, copies})
  }
  return duplicates.sort((a, b) => a.name.localeCompare(b.name))
}

export class Tracer {
  public ts: boolean
  public base: string
  public cwd: string
  public conditions: string[]
  public paths: Record<string, string>
  public ignoreFn: (path: string, parent?: string) => boolean
  public log: boolean
  public depth: number
  public assetExtensions: string[]
  public analysis: {
    evaluatePureExpressions?: boolean
  }
  private analysisCache: Map<string, AnalyzeResult>
  public fileList: Set<string>
  public processed: Set<string>
  // Maps a node_modules path that the trace made up (it is not on disk) to the
  // real directory of the package that deploys there.
  private placed = new Map<string, string>()
  // One entry per import of a package. The key is the first path the device
  // tries, `<importer's directory>/node_modules/<name>`. The value is the real
  // directory of the package the device has to find.
  private placements = new Map<string, string>()
  public warnings: Set<Error>
  public reasons: NodeFileTraceReasons = new Map()
  private cachedFileSystem: CachedFileSystem
  // Maps a deployed path to the file it is read from, where the two differ. For
  // example, node_modules/a/node_modules/b/index.js is read from
  // .pnpm/a@1/node_modules/b/index.js. Some of these paths exist on disk through
  // a symlink. Most do not, because pnpm does not link the dependencies of a
  // dependency into the app's node_modules.
  public virtualPathToRealPath = new Map<string, string>()

  constructor({
    base = process.cwd(),
    processCwd,
    exports,
    conditions = exports || ['node'],
    paths = {},
    ignore,
    log = false,
    ts = true,
    analysis = {},
    cache,
    fileIOConcurrency = 1024,
    depth = Infinity,
    assetExtensions = [],
  }: NodeFileTraceOptions) {
    this.ts = ts
    base = resolve(base)
    this.ignoreFn = () => false
    if (typeof ignore === 'string') ignore = [ignore]
    if (typeof ignore === 'function') {
      this.ignoreFn = ignore
    } else if (Array.isArray(ignore)) {
      const resolvedIgnores = ignore.map((ignore) =>
        relative(base, resolve(base || process.cwd(), ignore)),
      )
      this.ignoreFn = (path: string) =>
        resolvedIgnores.some((pattern) => matchesGlob(path, pattern))
    }
    this.base = base
    this.cwd = resolve(processCwd || base)
    this.conditions = conditions
    const resolvedPaths: Record<string, string> = {}
    for (const path of Object.keys(paths)) {
      const trailer = paths[path]!.endsWith('/')
      const resolvedPath = resolve(base, paths[path]!)
      resolvedPaths[path] = resolvedPath + (trailer ? '/' : '')
    }
    this.paths = resolvedPaths
    this.log = log
    this.depth = depth
    this.assetExtensions = assetExtensions
    this.cachedFileSystem = new CachedFileSystem({cache, fileIOConcurrency})
    this.analysis = {}
    if (analysis !== false) {
      Object.assign(
        this.analysis,
        {
          evaluatePureExpressions: true,
        },
        analysis === true ? {} : analysis,
      )
    }

    this.analysisCache = (cache && cache.analysisCache) || new Map()

    if (cache) {
      cache.analysisCache = this.analysisCache
    }

    this.fileList = new Set()
    this.processed = new Set()
    this.warnings = new Set()
  }

  async readlink(path: string) {
    return this.cachedFileSystem.readlink(path)
  }

  async isFile(path: string) {
    const stats = await this.stat(path)
    if (stats) return stats.isFile()
    return false
  }

  async stat(path: string) {
    return this.cachedFileSystem.stat(path)
  }

  private resolveWithTs = async (dep: string, parent: string) => {
    try {
      return await this.resolve(dep, parent, this)
    } catch (e1: any) {
      if (this.ts && dep.endsWith('.js') && e1 instanceof NotFoundError) {
        return await this.resolve(dep.slice(0, -3) + '.ts', parent, this)
      }
      throw e1
    }
  }

  // The real directory of the package that deploys at a node_modules path, or
  // undefined when no package does.
  private async packageAt(pkgDir: string): Promise<string | undefined> {
    const placed = this.placed.get(pkgDir)
    if (placed !== undefined) return placed
    return (await this.stat(pkgDir)) ? this.realpath(pkgDir) : undefined
  }

  // The real directory of the `name` that the package deployed at `pkgDir`
  // depends on. Node finds it in the package's own node_modules, or next to the
  // package (pnpm's layout).
  private async dependencyOf(pkgDir: string, name: string): Promise<string | undefined> {
    // This applies to a package's own directory only, not to a directory inside
    // it and not to node_modules itself.
    if (packageDirOf(pkgDir + sep + 'package.json') !== pkgDir) return undefined
    const real = await this.packageAt(pkgDir)
    if (real === undefined) return undefined
    const dirs = [real + NODE_MODULES]
    if (packageDirOf(real + sep + 'package.json') === real) {
      dirs.push(real.slice(0, real.lastIndexOf(NODE_MODULES) + NODE_MODULES.length))
    }
    for (const dir of dirs) {
      if (await this.stat(dir + name)) return this.realpath(dir + name)
    }
    return undefined
  }

  // The device has to reach the package each import was given before any other
  // package with that name. A package placed later in the trace can end up in
  // between, so this runs after the trace.
  async verifyPlacements() {
    for (const [first, realPkgDir] of this.placements) {
      const name = first.slice(first.lastIndexOf(NODE_MODULES) + NODE_MODULES.length)
      const from = first.slice(0, first.lastIndexOf(NODE_MODULES))
      let holds: string | undefined
      let dir = from
      for (; holds === undefined && (dir === this.base || inPath(dir, this.base));) {
        holds = await this.packageAt(dir + NODE_MODULES + name)
        if (holds === undefined) dir = dirname(dir)
      }
      if (holds === realPkgDir) continue
      this.warnings.add(
        new Error(
          `On the device, "${name}" imported from "${relative(this.base, from)}" resolves to ` +
            `"${relative(this.base, dir + NODE_MODULES + name)}", which is not the version ` +
            `the build resolved`,
        ),
      )
    }
  }

  // The path a resolved file deploys to, given where its importer deploys.
  // `resolved` is what Node finds from `realParent`. The device has no symlinks.
  // It walks up from the importer's deployed directory, looks in every
  // node_modules on the way, and takes the first package with that name. A
  // directory on the way up that already holds the same package is shared.
  // Otherwise the package nests under its importer
  // (node_modules/a/node_modules/b), where the walk finds it first.
  private async placeDependency(
    dep: string,
    resolved: string,
    parent: string,
    realParent: string,
  ): Promise<string | undefined> {
    let target = join(dirname(parent), relative(dirname(realParent), resolved))
    let found: string | undefined
    if (!dep.startsWith('.') && !dep.startsWith('#') && !isAbsolute(dep)) {
      for (let dir = dirname(realParent); found === undefined && dir !== dirname(dir);) {
        if (resolved.startsWith(dir + NODE_MODULES)) found = dir + NODE_MODULES
        dir = dirname(dir)
      }
    }
    if (found !== undefined) {
      const name = getPkgNameFromPath(resolved.slice(found.length))
      const realPkgDir = await this.realpath(found + name)
      let pkgDir: string | undefined
      for (let dir = dirname(parent); dir === this.base || inPath(dir, this.base);) {
        const holds = await this.packageAt(dir + NODE_MODULES + name)
        if (holds === realPkgDir) pkgDir = dir + NODE_MODULES + name
        // Another version here hides every copy further up.
        if (holds !== undefined) break
        // A package on the way up that depends on another version does the
        // same: that version nests here once the trace reaches the import.
        const nests = await this.dependencyOf(dir, name)
        if (nests !== undefined && nests !== realPkgDir) break
        dir = dirname(dir)
      }
      if (pkgDir === undefined) {
        // Two versions of two packages that import each other would nest without
        // end. No tree without symlinks can hold them. One copy above is fine: a
        // second copy below another version can share what the first one nested.
        // A third copy means the nesting repeats.
        const outer = (dir: string) => packageDirOf(dir.slice(0, dir.lastIndexOf(NODE_MODULES)))
        let copies = 0
        for (let dir = packageDirOf(parent); dir !== undefined; dir = outer(dir)) {
          if ((await this.packageAt(dir)) !== realPkgDir || ++copies < 2) continue
          this.warnings.add(
            new Error(
              `Cannot deploy "${name}", imported from "${relative(this.base, parent)}": ` +
                `packages on this path import each other at different versions, and the ` +
                `nesting would not end. Use one version of "${name}".`,
            ),
          )
          return undefined
        }
        pkgDir = (packageDirOf(parent) ?? this.base) + NODE_MODULES + name
        this.placed.set(pkgDir, realPkgDir)
      }
      this.placements.set(dirname(parent) + NODE_MODULES + name, realPkgDir)
      // The device reads the package's package.json to resolve the import.
      const realPjson = found + name + sep + 'package.json'
      if (await this.isFile(realPjson)) {
        const pjson = pkgDir + sep + 'package.json'
        if (pjson !== realPjson) this.virtualPathToRealPath.set(pjson, realPjson)
        await this.emitFile(pjson, 'resolve', parent)
      }
      target = pkgDir + resolved.slice(found.length + name.length)
    }
    if (target !== resolved) this.virtualPathToRealPath.set(target, resolved)
    return target
  }

  private maybeEmitDep = async (dep: string, path: string, realPath: string, depth: number) => {
    let resolved: string | string[]
    let from = realPath
    try {
      // Node resolves from the real path.
      resolved = await this.resolveWithTs(dep, realPath)
    } catch (error: any) {
      // The device walks up from the deployed path, and may find a package there
      // that the real path can't see.
      try {
        if (path === realPath) throw error
        resolved = await this.resolveWithTs(dep, path)
        from = path
      } catch {
        this.warnings.add(new Error(`Failed to resolve dependency "${dep}":\n${error?.message}`))
        return
      }
    }

    for (const item of Array.isArray(resolved) ? resolved : [resolved]) {
      const target = await this.placeDependency(dep, item, path, from)
      if (target !== undefined) await this.emitDependency(target, path, depth)
    }
  }

  async resolve(id: string, parent: string, job: Tracer): Promise<string | string[]> {
    return resolveDependency(id, parent, job)
  }

  async readFile(path: string): Promise<Buffer | string | null> {
    const realPath = this.virtualPathToRealPath.get(path)
    if (realPath) return this.cachedFileSystem.readFile(realPath)
    return this.cachedFileSystem.readFile(path)
  }

  async realpath(path: string, parent?: string, seen = new Set()): Promise<string> {
    // Check virtual path map — these are synthetic paths that don't exist on disk
    const mapped = this.virtualPathToRealPath.get(path)
    if (mapped) return this.realpath(mapped, parent, seen)

    if (seen.has(path)) throw new Error('Recursive symlink detected resolving ' + path)
    seen.add(path)
    const symlink = await this.readlink(path)
    if (symlink) {
      // Resolve the parent directory to its real path first so that relative
      // symlink targets are resolved against the actual filesystem location,
      // not the virtual path we were given. Without this, a relative symlink
      // accessed through a chain of symlinks (e.g. pnpm workspace transitive
      // dependencies) would resolve against the virtual path and land
      // somewhere non-existent.
      const parentPath = dirname(path)
      const realParentPath = await this.realpath(parentPath, parent, new Set(seen))
      const resolved = resolve(realParentPath, symlink)
      return this.realpath(resolved, parent, seen)
    }
    // If the path itself isn't a symlink, check if a parent directory is
    const parentDir = dirname(path)
    if (parentDir !== path) {
      const realParentDir = await this.realpath(parentDir, parent, seen)
      if (realParentDir !== parentDir) {
        return join(realParentDir, basename(path))
      }
    }
    if (!inPath(path, this.base)) return path
    return join(dirname(path), basename(path))
  }

  async emitFile(path: string, reasonType: NodeFileTraceReasonType, parent?: string) {
    // The given path is where the device looks. The real path is used only for a
    // file that was reached at a path outside base.
    path = relative(this.base, inPath(path, this.base) ? path : await this.realpath(path, parent))

    if (parent) {
      parent = relative(this.base, parent)
    }
    // A path above base can't be deployed. The device would not find the file,
    // so the build warns.
    if (path.startsWith('..' + sep)) {
      if (parent && reasonType === 'dependency') {
        this.warnings.add(
          new Error(
            `Cannot deploy "${path}", imported from "${parent}": it is outside the app directory`,
          ),
        )
      }
      return false
    }
    let reasonEntry = this.reasons.get(path)

    if (!reasonEntry) {
      reasonEntry = {
        type: [reasonType],
        ignored: false,
        parents: new Set(),
      }
      this.reasons.set(path, reasonEntry)
    } else if (!reasonEntry.type.includes(reasonType)) {
      reasonEntry.type.push(reasonType)
    }
    if (parent && this.ignoreFn(path, parent)) {
      if (!this.fileList.has(path) && reasonEntry) {
        reasonEntry.ignored = true
      }
      return false
    }
    if (parent) {
      reasonEntry.parents.add(parent)
    }
    this.fileList.add(path)
    return true
  }

  async getPjsonBoundary(path: string) {
    const rootSeparatorIndex = path.indexOf(sep)
    let separatorIndex: number
    while ((separatorIndex = path.lastIndexOf(sep)) > rootSeparatorIndex) {
      path = path.slice(0, separatorIndex)
      if (await this.isFile(path + sep + 'package.json')) return path
    }
    return undefined
  }

  async emitDependency(path: string, parent?: string, depth: number = this.depth) {
    if (depth < 0) throw new Error('invariant - depth option cannot be negative')

    const realPath = await this.realpath(path, parent)

    // A file reached at two paths deploys twice, and each copy finds its imports
    // from its own path.
    if (this.processed.has(path)) {
      if (parent) {
        await this.emitFile(path, 'dependency', parent)
      }
      return
    }
    this.processed.add(path)

    const emitted = await this.emitFile(path, 'dependency', parent)
    if (!emitted) return
    if (realPath.endsWith('.json')) return
    if (this.assetExtensions.some((ext) => realPath.endsWith(ext))) return

    // The nearest package.json deploys at the same place relative to the file.
    const pjsonBoundary = await this.getPjsonBoundary(realPath)
    let pjsonDir = pjsonBoundary
    if (pjsonBoundary && path !== realPath) {
      const tail = realPath.slice(pjsonBoundary.length)
      const pkgDir = packageDirOf(path)
      const dir = path.endsWith(tail) ? path.slice(0, -tail.length) : undefined
      // A package.json above the package is not part of what deploys here, so it
      // is neither emitted nor checked for `type: module`.
      const inPackage =
        dir !== undefined && pkgDir !== undefined && (dir + sep).startsWith(pkgDir + sep)
      pjsonDir = inPackage ? dir : undefined
    }
    if (pjsonBoundary && pjsonDir) {
      const pjsonEmitPath = pjsonDir + sep + 'package.json'
      if (pjsonDir !== pjsonBoundary) {
        this.virtualPathToRealPath.set(pjsonEmitPath, pjsonBoundary + sep + 'package.json')
      }
      await this.emitFile(pjsonEmitPath, 'resolve', path)
      const pjsonRaw = await this.readFile(pjsonEmitPath)
      if (!pjsonRaw) {
        throw new Error(`package.json found but not readable: ${pjsonEmitPath}`)
      }
      const pjson = JSON.parse(pjsonRaw.toString('utf-8'))
      if (pjson.type !== 'module') {
        throw new Error(`Non-ESM dependency detected: ${pjson.name}`)
      }
    }

    if (depth === 0) return

    let analyzeResult: AnalyzeResult

    const cachedAnalysis = this.analysisCache.get(realPath)
    if (cachedAnalysis) {
      analyzeResult = cachedAnalysis
    } else {
      const source = await this.readFile(realPath)
      if (source === null) throw new Error('File ' + realPath + ' does not exist.')
      analyzeResult = await analyze(realPath, source.toString(), this)
      this.analysisCache.set(realPath, analyzeResult)
    }

    const {imports} = analyzeResult

    await Promise.all(
      [...imports].map(async (dep) => {
        return this.maybeEmitDep(dep, path, realPath, depth - 1)
      }),
    )
  }
}
