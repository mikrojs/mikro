import {isAbsolute, resolve, sep} from 'path'

import type {FileSystem} from './fs.js'

export interface ResolveContext {
  fs: FileSystem
  conditions: string[]
  /** Try `.ts` and `.tsx` for an extensionless path under `base`, outside node_modules. */
  ts: boolean
  base: string
  /** Parsed package.json files by directory. Start with an empty map. */
  packageJsons: Map<string, Promise<PackageJson | undefined>>
}

// ESM-only node resolver.
export default async function resolveDependency(
  specifier: string,
  parent: string,
  ctx: ResolveContext,
): Promise<string> {
  let resolved: string
  if (
    isAbsolute(specifier) ||
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    const trailingSlash = specifier.endsWith('/')
    resolved = await resolvePath(
      resolve(parent, '..', specifier) + (trailingSlash ? '/' : ''),
      parent,
      ctx,
    )
  } else if (specifier[0] === '#') {
    resolved = await packageImportsResolve(specifier, parent, ctx)
  } else {
    resolved = await resolvePackage(specifier, parent, ctx)
  }

  return resolved
}

async function resolvePath(path: string, parent: string, ctx: ResolveContext): Promise<string> {
  const result = await resolveFile(path, parent, ctx)
  if (!result) {
    throw new NotFoundError(path, parent)
  }
  return result
}

async function resolveFile(
  path: string,
  parent: string,
  ctx: ResolveContext,
): Promise<string | undefined> {
  if (path.endsWith('/')) return undefined
  if (await isFile(ctx.fs, path)) return path
  if (
    ctx.ts &&
    path.startsWith(ctx.base) &&
    path.slice(ctx.base.length).indexOf(sep + 'node_modules' + sep) === -1 &&
    (await isFile(ctx.fs, path + '.ts'))
  )
    return path + '.ts'
  if (
    ctx.ts &&
    path.startsWith(ctx.base) &&
    path.slice(ctx.base.length).indexOf(sep + 'node_modules' + sep) === -1 &&
    (await isFile(ctx.fs, path + '.tsx'))
  )
    return path + '.tsx'
  if (await isFile(ctx.fs, path + '.js')) return path + '.js'
  if (await isFile(ctx.fs, path + '.json')) return path + '.json'
  return undefined
}

async function isFile(fs: FileSystem, path: string) {
  return (await fs.stat(path)) === 'file'
}

/** The nearest directory above `path` that has a package.json. */
export async function getPjsonBoundary(fs: FileSystem, path: string) {
  const rootSeparatorIndex = path.indexOf(sep)
  let separatorIndex: number
  while ((separatorIndex = path.lastIndexOf(sep)) > rootSeparatorIndex) {
    path = path.slice(0, separatorIndex)
    if (await isFile(fs, path + sep + 'package.json')) return path
  }
  return undefined
}

export class NotFoundError extends Error {
  public code: string
  constructor(specifier: string, parent: string) {
    super("Cannot find module '" + specifier + "' loaded from " + parent)
    this.code = 'MODULE_NOT_FOUND'
  }
}

function getPkgName(name: string) {
  const segments = name.split('/')
  if (name[0] === '@' && segments.length > 1)
    return segments.length > 1 ? segments.slice(0, 2).join('/') : null
  return segments.length ? segments[0] : null
}

type PackageTarget = string | PackageTarget[] | {[key: string]: PackageTarget} | null

export interface PackageJson {
  name?: unknown
  version?: unknown
  type?: unknown
  exports?: PackageTarget
  imports?: {[key: string]: PackageTarget}
}

/** The package.json of `dir`, read and parsed once. A file that is missing or
 *  is not valid JSON is undefined. */
export function readPackageJson(
  dir: string,
  ctx: ResolveContext,
): Promise<PackageJson | undefined> {
  let pjson = ctx.packageJsons.get(dir)
  if (pjson === undefined) {
    pjson = ctx.fs.readFile(dir + sep + 'package.json').then((source) => {
      if (source === undefined) return undefined
      try {
        return JSON.parse(source) as PackageJson
      } catch {
        return undefined
      }
    })
    ctx.packageJsons.set(dir, pjson)
  }
  return pjson
}

function getExportsTarget(exports: PackageTarget, conditions: string[]): string | null | undefined {
  if (typeof exports === 'string') {
    return exports
  } else if (exports === null) {
    return exports
  } else if (Array.isArray(exports)) {
    for (const item of exports) {
      const target = getExportsTarget(item, conditions)
      if (target === null || (typeof target === 'string' && target.startsWith('./'))) return target
    }
  } else if (typeof exports === 'object') {
    for (const condition of Object.keys(exports)) {
      if (condition === 'default' || condition === 'import' || conditions.includes(condition)) {
        const target = getExportsTarget(exports[condition]!, conditions)
        if (target !== undefined) return target
      }
    }
  }

  return undefined
}

async function existingFile(path: string, parent: string, ctx: ResolveContext): Promise<string> {
  if (!(await isFile(ctx.fs, path))) throw new NotFoundError(path, parent)
  return path
}

async function resolveExportsImports(
  pkgPath: string,
  obj: PackageTarget,
  subpath: string,
  ctx: ResolveContext,
  isImports: boolean,
  parent: string,
): Promise<string | undefined> {
  let matchObj: {[key: string]: PackageTarget}
  if (isImports) {
    if (!(typeof obj === 'object' && !Array.isArray(obj) && obj !== null)) return undefined
    matchObj = obj
  } else if (
    typeof obj === 'string' ||
    Array.isArray(obj) ||
    obj === null ||
    (typeof obj === 'object' && Object.keys(obj).length && Object.keys(obj)[0]![0] !== '.')
  ) {
    matchObj = {'.': obj}
  } else {
    matchObj = obj
  }

  if (subpath in matchObj) {
    const target = getExportsTarget(matchObj[subpath]!, ctx.conditions)
    if (typeof target === 'string' && target.startsWith('./')) {
      const resolvedPath = pkgPath + target.slice(1)
      return existingFile(resolvedPath, parent, ctx)
    }
  }
  for (const match of Object.keys(matchObj).sort((a, b) => b.length - a.length)) {
    if (match.endsWith('*') && subpath.startsWith(match.slice(0, -1))) {
      const target = getExportsTarget(matchObj[match]!, ctx.conditions)
      if (typeof target === 'string' && target.startsWith('./')) {
        const resolvedPath =
          pkgPath + target.slice(1).replace(/\*/g, subpath.slice(match.length - 1))
        return existingFile(resolvedPath, parent, ctx)
      }
    }
    if (!match.endsWith('/')) continue
    if (subpath.startsWith(match)) {
      const target = getExportsTarget(matchObj[match]!, ctx.conditions)
      if (typeof target === 'string' && target.endsWith('/') && target.startsWith('./')) {
        const resolvedPath = pkgPath + target.slice(1) + subpath.slice(match.length)
        return existingFile(resolvedPath, parent, ctx)
      }
    }
  }
  return undefined
}

async function packageImportsResolve(
  name: string,
  parent: string,
  ctx: ResolveContext,
): Promise<string> {
  if (name !== '#' && !name.startsWith('#/')) {
    const pjsonBoundary = await getPjsonBoundary(ctx.fs, parent)
    if (pjsonBoundary) {
      const pkgCfg = await readPackageJson(pjsonBoundary, ctx)
      const {imports: pkgImports} = pkgCfg || {}
      if (pkgCfg && pkgImports !== null && pkgImports !== undefined) {
        const importsResolved = await resolveExportsImports(
          pjsonBoundary,
          pkgImports,
          name,
          ctx,
          true,
          parent,
        )
        if (importsResolved) return importsResolved
      }
    }
  }
  throw new NotFoundError(name, parent)
}

async function resolvePackage(name: string, parent: string, ctx: ResolveContext): Promise<string> {
  let packageParent = parent
  if (name.startsWith('node:')) {
    throw new Error('node: imports not supported')
  }

  const pkgName = getPkgName(name) || ''
  const subpath = '.' + name.slice(pkgName.length)

  // A package's own name resolves through its own exports first, as in Node.
  const pjsonBoundary = await getPjsonBoundary(ctx.fs, parent)
  if (pjsonBoundary) {
    const pkgCfg = await readPackageJson(pjsonBoundary, ctx)
    const pkgExports = pkgCfg?.exports
    if (pkgCfg?.name === pkgName && pkgExports !== null && pkgExports !== undefined) {
      const resolved = await resolveExportsImports(
        pjsonBoundary,
        pkgExports,
        subpath,
        ctx,
        false,
        parent,
      )
      if (resolved) return resolved
    }
  }

  let separatorIndex: number
  const rootSeparatorIndex = packageParent.indexOf(sep)
  while ((separatorIndex = packageParent.lastIndexOf(sep)) > rootSeparatorIndex) {
    packageParent = packageParent.slice(0, separatorIndex)
    const nodeModulesDir = packageParent + sep + 'node_modules'
    const stat = await ctx.fs.stat(nodeModulesDir)
    if (stat !== 'directory') continue
    const pkgCfg = await readPackageJson(nodeModulesDir + sep + pkgName, ctx)
    const pkgExports = pkgCfg?.exports

    const resolved =
      pkgExports !== undefined && pkgExports !== null
        ? await resolveExportsImports(
            nodeModulesDir + sep + pkgName,
            pkgExports,
            subpath,
            ctx,
            false,
            parent,
          )
        : await resolveFile(nodeModulesDir + sep + name, parent, ctx)
    if (resolved) return resolved
  }
  throw new NotFoundError(name, parent)
}
