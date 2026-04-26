import {isAbsolute, resolve, sep} from 'path'

import type {Tracer} from './trace.js'

// ESM-only node resolver.
// Custom implementation to emit only needed package.json files for resolver
// (package.json files are emitted as they are hit).
export default async function resolveDependency(
  specifier: string,
  parent: string,
  job: Tracer,
): Promise<string | string[]> {
  let resolved: string | string[]
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
      job,
    )
  } else if (specifier[0] === '#') {
    resolved = await packageImportsResolve(specifier, parent, job)
  } else {
    resolved = await resolvePackage(specifier, parent, job)
  }

  return resolved
}

async function resolvePath(path: string, parent: string, job: Tracer): Promise<string> {
  const result = await resolveFile(path, parent, job)
  if (!result) {
    throw new NotFoundError(path, parent)
  }
  return result
}

async function resolveFile(path: string, parent: string, job: Tracer): Promise<string | undefined> {
  if (path.endsWith('/')) return undefined
  //path = await job.realpath(path, parent)
  if (await job.isFile(path)) return path
  if (
    job.ts &&
    path.startsWith(job.base) &&
    path.slice(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 &&
    (await job.isFile(path + '.ts'))
  )
    return path + '.ts'
  if (
    job.ts &&
    path.startsWith(job.base) &&
    path.slice(job.base.length).indexOf(sep + 'node_modules' + sep) === -1 &&
    (await job.isFile(path + '.tsx'))
  )
    return path + '.tsx'
  if (await job.isFile(path + '.js')) return path + '.js'
  if (await job.isFile(path + '.json')) return path + '.json'
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

interface PkgCfg {
  name: string | undefined
  main: string | undefined
  exports: PackageTarget
  imports: {[key: string]: PackageTarget}
}

async function getPkgCfg(pkgPath: string, job: Tracer): Promise<PkgCfg | undefined> {
  const pjsonSource = await job.readFile(pkgPath + sep + 'package.json')
  if (pjsonSource) {
    try {
      return JSON.parse(pjsonSource.toString())
    } catch {
      // invalid JSON → treat as missing config
    }
  }
  return undefined
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

async function validateAndResolvePaths(
  paths: string[],
  parent: string,
  job: Tracer,
): Promise<string[]> {
  const validatedPaths: string[] = []
  for (const path of paths) {
    if (!(await job.isFile(path))) throw new NotFoundError(path, parent)
    validatedPaths.push(path)
  }
  return validatedPaths
}

async function resolveExportsImports(
  pkgPath: string,
  obj: PackageTarget,
  subpath: string,
  job: Tracer,
  isImports: boolean,
  parent: string,
): Promise<string[] | undefined> {
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
    const target = getExportsTarget(matchObj[subpath]!, job.conditions)
    if (typeof target === 'string' && target.startsWith('./')) {
      const resolvedPath = pkgPath + target.slice(1)
      return await validateAndResolvePaths([resolvedPath], parent, job)
    }
  }
  for (const match of Object.keys(matchObj).sort((a, b) => b.length - a.length)) {
    if (match.endsWith('*') && subpath.startsWith(match.slice(0, -1))) {
      const target = getExportsTarget(matchObj[match]!, job.conditions)
      if (typeof target === 'string' && target.startsWith('./')) {
        const resolvedPath =
          pkgPath + target.slice(1).replace(/\*/g, subpath.slice(match.length - 1))
        return await validateAndResolvePaths([resolvedPath], parent, job)
      }
    }
    if (!match.endsWith('/')) continue
    if (subpath.startsWith(match)) {
      const target = getExportsTarget(matchObj[match]!, job.conditions)
      if (typeof target === 'string' && target.endsWith('/') && target.startsWith('./')) {
        const resolvedPath = pkgPath + target.slice(1) + subpath.slice(match.length)
        return await validateAndResolvePaths([resolvedPath], parent, job)
      }
    }
  }
  return undefined
}

async function packageImportsResolve(name: string, parent: string, job: Tracer): Promise<string[]> {
  if (name !== '#' && !name.startsWith('#/') && job.conditions) {
    const pjsonBoundary = await job.getPjsonBoundary(parent)
    if (pjsonBoundary) {
      const pkgCfg = await getPkgCfg(pjsonBoundary, job)
      const {imports: pkgImports} = pkgCfg || {}
      if (pkgCfg && pkgImports !== null && pkgImports !== undefined) {
        const importsResolved = await resolveExportsImports(
          pjsonBoundary,
          pkgImports,
          name,
          job,
          true,
          parent,
        )
        if (importsResolved) {
          await job.emitFile(pjsonBoundary + sep + 'package.json', 'resolve', parent)
          return importsResolved
        }
      }
    }
  }
  throw new NotFoundError(name, parent)
}

async function resolvePackage(
  name: string,
  parent: string,
  job: Tracer,
): Promise<string | string[]> {
  let packageParent = parent
  if (name.startsWith('node:')) {
    throw new Error('node: imports not supported')
  }

  const pkgName = getPkgName(name) || ''

  // package own name resolution
  let selfResolved: string | string[] | undefined
  if (job.conditions) {
    const pjsonBoundary = await job.getPjsonBoundary(parent)
    if (pjsonBoundary) {
      const pkgCfg = await getPkgCfg(pjsonBoundary, job)
      const {exports: pkgExports} = pkgCfg || {}
      if (
        pkgCfg &&
        pkgCfg.name &&
        pkgCfg.name === pkgName &&
        pkgExports !== null &&
        pkgExports !== undefined
      ) {
        selfResolved = await resolveExportsImports(
          pjsonBoundary,
          pkgExports,
          '.' + name.slice(pkgName.length),
          job,
          false,
          parent,
        )
        if (selfResolved)
          await job.emitFile(pjsonBoundary + sep + 'package.json', 'resolve', parent)
      }
    }
  }

  let separatorIndex: number
  const rootSeparatorIndex = packageParent.indexOf(sep)
  while ((separatorIndex = packageParent.lastIndexOf(sep)) > rootSeparatorIndex) {
    packageParent = packageParent.slice(0, separatorIndex)
    const nodeModulesDir = packageParent + sep + 'node_modules'
    const stat = await job.stat(nodeModulesDir)
    if (!stat || !stat.isDirectory()) continue
    const pkgCfg = await getPkgCfg(nodeModulesDir + sep + pkgName, job)
    const {exports: pkgExports} = pkgCfg || {}

    if (job.conditions && pkgExports !== undefined && pkgExports !== null && !selfResolved) {
      const resolved = await resolveExportsImports(
        nodeModulesDir + sep + pkgName,
        pkgExports,
        '.' + name.slice(pkgName.length),
        job,
        false,
        parent,
      )
      if (resolved) {
        await job.emitFile(nodeModulesDir + sep + pkgName + sep + 'package.json', 'resolve', parent)
        return resolved
      }
    } else {
      const resolved = await resolveFile(nodeModulesDir + sep + name, parent, job)
      if (resolved) {
        if (selfResolved) {
          if (Array.isArray(selfResolved)) {
            if (!selfResolved.includes(resolved)) return [resolved, ...selfResolved]
            return selfResolved
          } else if (selfResolved !== resolved) {
            return [resolved, selfResolved]
          }
        }
        return resolved
      }
    }
  }
  if (selfResolved) return selfResolved
  if (Object.hasOwnProperty.call(job.paths, name)) {
    return job.paths[name]!
  }
  for (const path of Object.keys(job.paths)) {
    if (path.endsWith('/') && name.startsWith(path)) {
      const pathTarget = job.paths[path] + name.slice(path.length)
      const resolved = await resolveFile(pathTarget, parent, job)
      if (!resolved) {
        throw new NotFoundError(name, parent)
      }
      return resolved
    }
  }
  throw new NotFoundError(name, parent)
}
