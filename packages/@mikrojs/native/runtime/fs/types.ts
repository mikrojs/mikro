import type {Result} from '../result/types.js'

/**
 * Curated FSError variants. Each carries only the context that's
 * meaningful for that error:
 *   - `path` for most entries
 *   - `limit` for TooLarge (the readFile cap; currently always absent
 *     because native doesn't report the configured fs_read_max back)
 *   - `code`/`errno`/`message` for Unknown, carrying the raw native
 *     error through for debugging when a POSIX errno falls outside
 *     the curated set
 *
 * Discriminate on `.name`.
 */
export type FSError =
  | {name: 'NotFound'; path: string}
  | {name: 'AlreadyExists'; path: string}
  | {name: 'AccessDenied'; path: string}
  | {name: 'NoSpace'; path: string}
  | {name: 'TooLarge'; path: string; limit?: number}
  | {name: 'IsDirectory'; path: string}
  | {name: 'NotDirectory'; path: string}
  | {name: 'BadFileDescriptor'}
  | {name: 'Unknown'; code: number; errno: number | undefined; message: string}

export interface WriteFileOptions {
  /** If false, fail with NotFound when the file doesn't exist. Default true. */
  create?: boolean
  /** If true, append instead of truncating. Default false. */
  append?: boolean
}

export declare function writeFile(
  path: string,
  contents: string | Uint8Array,
  options?: WriteFileOptions,
): Result<void, FSError>

export declare function readFile(path: string): Result<Uint8Array, FSError>
export declare function readFile(path: string, encoding: 'utf-8'): Result<string, FSError>

export interface StatResult {
  size: number
  isDirectory: boolean
  isFile: boolean
  /** Modification time in ms since epoch. Absent if the platform doesn't
   * track it (e.g. LittleFS without CONFIG_LITTLEFS_USE_MTIME). */
  mtime?: number
}

export declare function stat(path: string): Result<StatResult, FSError>

export interface DirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

export declare function readDir(path: string): Result<DirEntry[], FSError>
export declare function unlink(path: string): Result<void, FSError>
export declare function rename(from: string, to: string): Result<void, FSError>

export interface MkdirOptions {
  /** Create intermediate directories as needed (like `mkdir -p`). Default false. */
  recursive?: boolean
}

export declare function mkdir(path: string, options?: MkdirOptions): Result<void, FSError>
export declare function rmdir(path: string): Result<void, FSError>

/** Returns true when the path exists and is reachable, false otherwise.
 * Never fails — resolution errors collapse to false. */
export declare function exists(path: string): boolean

export interface ReadStreamOptions {
  /** Bytes to read per chunk. Default 512. */
  chunkSize?: number
}

/**
 * Open a file as a stream of byte chunks. Returns a Result because the
 * initial open can fail; once iterating, mid-stream read errors propagate
 * via rejected promises from `next()`.
 *
 * Compose with `mikrojs/stream` helpers (`decodeUtf8`, `splitLines`) for
 * text/line streams. Closes the underlying handle on EOF, mid-stream
 * error, or early consumer break.
 */
export declare function readStream(
  path: string,
  options?: ReadStreamOptions,
): Result<AsyncIterable<Uint8Array>, FSError>
