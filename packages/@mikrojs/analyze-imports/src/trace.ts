import {matchesGlob} from 'node:path'

import {basename, dirname, join, relative, resolve, sep} from 'path'

import analyze, {type AnalyzeResult} from './analyze.js'
import {CachedFileSystem} from './fs.js'
import resolveDependency, {NotFoundError} from './resolve.js'
import type {
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
  public warnings: Set<Error>
  public reasons: NodeFileTraceReasons = new Map()
  private cachedFileSystem: CachedFileSystem
  // Maps virtual paths (e.g. node_modules/A/node_modules/B/index.js) to their
  // real filesystem paths (e.g. .pnpm/A@1/node_modules/B/index.js).
  // This is needed for pnpm symlink stores where transitive dependencies don't
  // have their own symlink in the project's node_modules.
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
      const ig = ignore
      this.ignoreFn = (path: string) => {
        if (path.startsWith('..' + sep)) return true
        if (ig(path)) return true
        return false
      }
    } else if (Array.isArray(ignore)) {
      const resolvedIgnores = ignore.map((ignore) =>
        relative(base, resolve(base || process.cwd(), ignore)),
      )
      this.ignoreFn = (path: string) => {
        if (path.startsWith('..' + sep)) return true
        if (resolvedIgnores.some((pattern) => matchesGlob(path, pattern))) return true
        return false
      }
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

  // Remap a resolved real path to a virtual path nested under the symlink parent's
  // package directory. This makes pnpm transitive dependencies appear as nested
  // node_modules in the output (e.g. node_modules/A/node_modules/B/...).
  private remapToVirtualPath(resolved: string, symlinkParent: string, realParent: string): string {
    // Find the last node_modules/ segment in the real parent to locate the
    // pnpm virtual store's node_modules directory
    const nmSegment = sep + 'node_modules' + sep
    const realNmIdx = realParent.lastIndexOf(nmSegment)
    if (realNmIdx === -1) return resolved
    const realNodeModulesDir = realParent.slice(0, realNmIdx + nmSegment.length - 1)

    if (!resolved.startsWith(realNodeModulesDir + sep)) return resolved
    // tail = "parse-ms/index.js"
    const tail = resolved.slice(realNodeModulesDir.length + 1)

    // Find the symlink parent's package directory
    const symlinkNmIdx = symlinkParent.lastIndexOf(nmSegment)
    if (symlinkNmIdx === -1) return resolved
    const afterNm = symlinkParent.slice(symlinkNmIdx + nmSegment.length)
    const pkgName = getPkgNameFromPath(afterNm)
    const symlinkPkgDir = symlinkParent.slice(0, symlinkNmIdx + nmSegment.length) + pkgName

    // Construct virtual path: .../node_modules/A/node_modules/B/index.js
    const virtualPath = join(symlinkPkgDir, 'node_modules', tail)

    // Store mapping so realpath() and readFile() can find the real file
    this.virtualPathToRealPath.set(virtualPath, resolved)
    return virtualPath
  }

  private remapResolved(
    resolved: string | string[],
    symlinkParent: string,
    realParent: string,
  ): string | string[] {
    if (Array.isArray(resolved)) {
      return resolved.map((r) => this.remapToVirtualPath(r, symlinkParent, realParent))
    }
    return this.remapToVirtualPath(resolved, symlinkParent, realParent)
  }

  private maybeEmitDep = async (
    dep: string,
    symlinkPath: string,
    realPath: string,
    depth: number,
  ) => {
    let resolved: string | string[] = ''
    let error: Error | undefined

    // First, try resolving from the symlink path
    try {
      resolved = await this.resolveWithTs(dep, symlinkPath)
    } catch (e1: any) {
      error = e1
    }

    // If resolution failed and the real path differs from the symlink path,
    // try resolving from the real path and remap the result to a virtual
    // symlink-relative path (needed for pnpm transitive dependencies)
    if (error && realPath !== symlinkPath) {
      try {
        resolved = await this.resolveWithTs(dep, realPath)
        resolved = this.remapResolved(resolved, symlinkPath, realPath)
        error = undefined
      } catch {
        // Keep original error
      }
    }

    if (error) {
      this.warnings.add(new Error(`Failed to resolve dependency "${dep}":\n${error?.message}`))
      return
    }

    if (Array.isArray(resolved)) {
      for (const item of resolved) {
        await this.emitDependency(item, symlinkPath, depth)
      }
    } else {
      await this.emitDependency(resolved, symlinkPath, depth)
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
    const real = await this.realpath(path, parent)
    // Prefer the real path, but fall back to the original (symlink-based) path when
    // the real path is outside base — the file is still reachable at the symlink path.
    path = relative(this.base, inPath(real, this.base) ? real : path)

    if (parent) {
      parent = relative(this.base, parent)
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

    if (this.processed.has(realPath)) {
      if (parent) {
        await this.emitFile(path, 'dependency', parent)
      }
      return
    }
    this.processed.add(realPath)

    const emitted = await this.emitFile(path, 'dependency', parent)
    if (!emitted) return
    if (realPath.endsWith('.json')) return
    if (this.assetExtensions.some((ext) => realPath.endsWith(ext))) return

    // Check for package.json boundary — use the path that's inside base
    // (which may be a virtual path for remapped pnpm transitive deps)
    const isVirtual = this.virtualPathToRealPath.has(path)
    const pjsonSearchPath = inPath(realPath, this.base) ? realPath : isVirtual ? path : undefined
    const pjsonBoundary = pjsonSearchPath
      ? await this.getPjsonBoundary(isVirtual ? realPath : pjsonSearchPath)
      : undefined
    if (pjsonBoundary) {
      let pjsonEmitPath = pjsonBoundary + sep + 'package.json'
      // For virtual paths, the pjsonBoundary is on the real filesystem but we need
      // to emit the package.json under the virtual tree
      if (isVirtual && !inPath(pjsonBoundary, this.base)) {
        // Walk up from the virtual path to the package root (find last node_modules/pkg)
        const nmSegment = sep + 'node_modules' + sep
        const nmIdx = path.lastIndexOf(nmSegment)
        if (nmIdx !== -1) {
          const afterNm = path.slice(nmIdx + nmSegment.length)
          const pkgName = getPkgNameFromPath(afterNm)
          const virtualPjsonDir = path.slice(0, nmIdx + nmSegment.length) + pkgName
          const virtualPjsonPath = virtualPjsonDir + sep + 'package.json'
          this.virtualPathToRealPath.set(virtualPjsonPath, pjsonEmitPath)
          pjsonEmitPath = virtualPjsonPath
        }
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
