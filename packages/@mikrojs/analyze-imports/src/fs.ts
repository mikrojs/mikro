import {readFile, readlink, stat} from 'node:fs/promises'
import {basename, dirname, join, resolve} from 'node:path'

export type FileKind = 'file' | 'directory'

/** What the trace reads. Every method returns undefined for a missing path. */
export interface FileSystem {
  readFile(path: string): Promise<string | undefined>
  /** Follows symlinks. */
  stat(path: string): Promise<FileKind | undefined>
  /** The link target as written, or undefined when the path is not a symlink. */
  readlink(path: string): Promise<string | undefined>
}

function cached<T>(read: (path: string) => Promise<T>): (path: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>()
  return (path) => {
    let result = cache.get(path)
    if (result === undefined) {
      result = read(path)
      cache.set(path, result)
    }
    return result
  }
}

async function missing<T>(codes: string[], read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (codes.includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
}

/** The disk, with every answer cached for the lifetime of the returned object. */
export function nodeFileSystem(): FileSystem {
  return {
    readFile: cached((path) =>
      missing(['ENOENT', 'ENOTDIR', 'EISDIR'], () => readFile(path, 'utf-8')),
    ),
    stat: cached((path) =>
      missing(['ENOENT', 'ENOTDIR'], async () => {
        const stats = await stat(path)
        return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : undefined
      }),
    ),
    readlink: cached((path) => missing(['EINVAL', 'ENOENT', 'ENOTDIR'], () => readlink(path))),
  }
}

/** Resolves every symlink on the way to `path`. A missing path is returned as is. */
export async function realpath(
  fs: FileSystem,
  path: string,
  seen = new Set<string>(),
): Promise<string> {
  if (seen.has(path)) throw new Error('Recursive symlink detected resolving ' + path)
  seen.add(path)
  const parent = dirname(path)
  if (parent === path) return path
  // The parent first: a relative link target is relative to the real directory.
  const realParent = await realpath(fs, parent, new Set(seen))
  const candidate = join(realParent, basename(path))
  const link = await fs.readlink(candidate)
  if (link === undefined) return candidate
  return realpath(fs, resolve(realParent, link), seen)
}
