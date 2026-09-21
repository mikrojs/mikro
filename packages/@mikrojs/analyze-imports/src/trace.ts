import {resolve} from 'node:path'

import {discover} from './discover.js'
import {type FileSystem, nodeFileSystem, realpath} from './fs.js'
import {type Layout, layout, type Rewrite} from './layout.js'

export interface TraceImportsOptions {
  /** The app directory. Defaults to the working directory. */
  root?: string
  /** The directory, relative to `root`, that becomes the root of the device's
   *  file system. A file outside it deploys inside it. Defaults to `root`. */
  deployDir?: string
  /** Defaults to the disk. */
  fs?: FileSystem
  /** Export conditions to accept besides `import` and `default`. */
  conditions?: string[]
  /** True for a specifier the firmware provides: it is reported, not resolved. */
  isExternal?: (specifier: string) => boolean
  /** Files with these extensions deploy, but are not parsed. */
  assetExtensions?: string[]
}

export type TraceImportsResult = Layout

/**
 * Follows the imports of `entries` (a relative entry is relative to the working
 * directory, not to `root`) and says which files deploy, where, and with
 * which import specifiers replaced. Reads the file system and changes nothing;
 * what the build cannot deploy is listed in `problems`, not thrown.
 */
export async function traceImports(
  entries: string[],
  options: TraceImportsOptions = {},
): Promise<TraceImportsResult> {
  const fs = options.fs ?? nodeFileSystem()
  const root = await realpath(fs, resolve(options.root ?? process.cwd()))
  const graph = await discover(entries, {
    fs,
    root,
    conditions: options.conditions ?? [],
    isExternal: options.isExternal ?? (() => false),
    assetExtensions: options.assetExtensions ?? [],
  })
  return layout(graph, root, options.deployDir)
}

/** `code` with every rewrite applied. */
export function applyRewrites(code: string, rewrites: Rewrite[]): string {
  // Last first, so an edit does not move the ranges before it.
  for (const {start, end, text} of [...rewrites].sort((a, b) => b.start - a.start)) {
    code = code.slice(0, start) + text + code.slice(end)
  }
  return code
}
