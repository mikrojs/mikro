export {nodeFileTrace} from './trace.js'
export * from './types.js'
import resolveDependency from './resolve.js'
import type {Tracer} from './trace.js'

export type {FileKind, FileSystem} from './fs.js'
export {nodeFileSystem} from './fs.js'

export function resolve(id: string, parent: string, job: Tracer) {
  return resolveDependency(id, parent, job.resolveContext)
}

export type {DeployedFile, Rewrite} from './layout.js'
export {
  applyRewrites,
  traceImports,
  type TraceImportsOptions,
  type TraceImportsResult,
} from './traceImports.js'
