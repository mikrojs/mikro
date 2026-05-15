import {err, ok} from 'mikrojs/result'
import * as native from 'native:fs'

import type {Result} from '../result/types.js'
import type {
  DirEntry,
  FSError,
  MkdirOptions,
  ReadStreamOptions,
  StatResult,
  WriteFileOptions,
} from './types.js'

// native:fs emits typed FSError variants directly (see mik__fs_err_result in
// src/fs.cpp), including the `path` field for path-level operations. These
// wrappers are thin pass-throughs that only exist to expose a typed public
// API surface for mikrojs/fs.

export function readFile(path: string): Result<Uint8Array, FSError>
export function readFile(path: string, encoding: 'utf-8'): Result<string, FSError>
export function readFile(path: string, encoding?: 'utf-8'): Result<Uint8Array | string, FSError> {
  return encoding ? native.readFile(path, encoding) : native.readFile(path)
}

export function writeFile(
  path: string,
  contents: string | Uint8Array,
  options?: WriteFileOptions,
): Result<void, FSError> {
  return typeof contents === 'string'
    ? native.writeFile(path, contents, options)
    : native.writeFile(path, contents, options)
}

export function stat(path: string): Result<StatResult, FSError> {
  return native.stat(path)
}

export function readDir(path: string): Result<DirEntry[], FSError> {
  return native.readDir(path)
}

export function unlink(path: string): Result<void, FSError> {
  return native.unlink(path)
}

export function rename(from: string, to: string): Result<void, FSError> {
  return native.rename(from, to)
}

export function mkdir(path: string, options?: MkdirOptions): Result<void, FSError> {
  return native.mkdir(path, options)
}

export function rmdir(path: string): Result<void, FSError> {
  return native.rmdir(path)
}

export const exists = native.exists

export function readStream(
  path: string,
  options?: ReadStreamOptions,
): Result<AsyncIterable<Result<Uint8Array, FSError>>, FSError> {
  const openResult = native.open(path)
  if (!openResult.ok) return openResult
  const fh = openResult.value
  const chunkSize = options?.chunkSize ?? 512

  async function* iterate(): AsyncIterable<Result<Uint8Array, FSError>> {
    try {
      while (true) {
        const r = fh.read(chunkSize)
        if (!r.ok) {
          // Handle-level errors (BadFileDescriptor, Unknown) don't carry a
          // path from the native side. Path-aware variants are decorated
          // here so consumers see the original readStream context.
          const e = r.error
          yield e.name === 'BadFileDescriptor' || e.name === 'Unknown' ? err(e) : err({...e, path})
          return
        }
        if (r.value === undefined) break
        yield ok(r.value)
      }
    } finally {
      fh.close()
    }
  }

  return ok(iterate())
}
