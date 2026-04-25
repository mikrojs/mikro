import type {Tracer} from './trace.js'

export interface Stats {
  isFile(): boolean
  isDirectory(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
  isSymbolicLink(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  dev: number
  ino: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  blksize: number
  blocks: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
}

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
  cache?: any
  paths?: Record<string, string>
  ts?: boolean
  log?: boolean
  readFile?: (path: string) => Promise<Buffer | string | null>
  stat?: (path: string) => Promise<Stats | null>
  readlink?: (path: string) => Promise<string | null>
  resolve?: (id: string, parent: string, job: Tracer) => Promise<string | string[]>
  fileIOConcurrency?: number
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

export interface NodeFileTraceResult {
  fileList: Set<string>
  reasons: NodeFileTraceReasons
  warnings: Set<Error>
  // Maps output file paths to their real source paths on disk.
  // Files not in this map can be read directly from their path.
  // Populated for pnpm transitive dependencies that are remapped
  // from the pnpm store to virtual nested node_modules paths.
  sourcePathMap: Map<string, string>
}
