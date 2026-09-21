import type {FileSystem} from './fs.js'
import type {Tracer} from './trace.js'

export interface NodeFileTraceOptions {
  base?: string
  processCwd?: string
  exports?: string[]
  conditions?: string[]
  ignore?: string | string[] | ((path: string) => boolean)
  analysis?:
    | boolean
    | {
        evaluatePureExpressions?: boolean
      }
  paths?: Record<string, string>
  ts?: boolean
  log?: boolean
  /** Defaults to the disk. */
  fs?: FileSystem
  resolve?: (id: string, parent: string, job: Tracer) => Promise<string | string[]>
  depth?: number
  assetExtensions?: string[]
}

export type NodeFileTraceReasonType = 'initial' | 'resolve' | 'dependency' | 'asset'

export interface NodeFileTraceReasons extends Map<
  string,
  {
    type: NodeFileTraceReasonType[]
    ignored: boolean
    parents: Set<string>
  }
> {}

/** A package name traced at more than one package directory. */
export interface DuplicatePackage {
  name: string
  /** One entry per directory, sorted by path. `version` is from its package.json. */
  copies: {path: string; version?: string}[]
}

export interface NodeFileTraceResult {
  fileList: Set<string>
  reasons: NodeFileTraceReasons
  warnings: Set<Error>
  // Packages still in fileList more than once after the hoist. Not a warning:
  // each copy ships and loads as its own module instance, but the trace is valid.
  duplicatePackages: DuplicatePackage[]
  // Maps output file paths to their real source paths on disk.
  // Files not in this map can be read directly from their path.
  // Populated for pnpm transitive dependencies that are remapped
  // from the pnpm store to virtual nested node_modules paths.
  sourcePathMap: Map<string, string>
  // Raw specifiers imported ONLY via dynamic import() across the traced
  // graph. A specifier also imported statically anywhere is not listed.
  dynamicOnlyImports: Set<string>
}
