import {dirname, resolve, sep} from 'node:path'

import type {FileSystem} from '../src/index.js'

/** An in-memory tree. `files` maps absolute paths to contents, `links` maps
 *  absolute paths to symlink targets (relative targets are relative to the link's
 *  directory). Directories are implied. */
export function memoryFs(files: Record<string, string>, links: Record<string, string> = {}) {
  const directories = new Set<string>()
  for (const path of [...Object.keys(files), ...Object.keys(links)]) {
    for (let dir = dirname(path); !directories.has(dir); dir = dirname(dir)) directories.add(dir)
  }

  // Follows the links in every segment but the last.
  function resolveParent(path: string, depth = 0): string {
    if (depth > 40) throw new Error('Too many symlinks: ' + path)
    let real: string = sep
    const segments = path.split(sep).filter(Boolean)
    for (const [i, segment] of segments.entries()) {
      const next = resolve(real, segment)
      const link = i < segments.length - 1 ? links[next] : undefined
      real = link === undefined ? next : follow(resolve(real, link), depth + 1)
    }
    return real
  }

  function follow(path: string, depth = 0): string {
    const real = resolveParent(path, depth)
    const link = links[real]
    return link === undefined ? real : follow(resolve(dirname(real), link), depth + 1)
  }

  const fs: FileSystem = {
    readFile: async (path) => files[follow(path)],
    stat: async (path) => {
      const real = follow(path)
      return real in files ? 'file' : directories.has(real) ? 'directory' : undefined
    },
    readlink: async (path) => links[resolveParent(path)],
  }
  return fs
}
