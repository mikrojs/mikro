import fs from 'node:fs'
import path from 'node:path'

import {formatTargetDir} from './names.js'

/** Why the project can't go in `targetDir` of `cwd`, if it can't. `idf`:
 *  ESP-IDF builds in the folder. */
export function targetDirProblem(targetDir: string, cwd: string, idf: boolean): string | undefined {
  const root = path.resolve(cwd, targetDir)
  if (idf && root.includes(' ')) {
    return `ESP-IDF can't build in a path with spaces: "${root}". Choose a folder without them.`
  }
  if (root === cwd) {
    return fs.existsSync(path.join(root, 'package.json'))
      ? 'Current directory already contains a package.json.'
      : undefined
  }
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch (err) {
    // Nothing there yet is the usual case
    const {code, message} = err as NodeJS.ErrnoException
    if (code === 'ENOENT') return undefined
    // The name of a file, or a path through one
    if (code === 'ENOTDIR') return `"${targetDir}" is not a directory: a file is in the way.`
    return `Can't use "${targetDir}": ${message}`
  }
  return entries.length > 0
    ? `Directory "${targetDir}" already exists and is not empty.`
    : undefined
}

/** What the name prompt answers to `typed`: nothing when the project can go
 *  there. An empty line stands for `fallback`, the default the prompt shows,
 *  which clack applies only after this has passed. */
export function projectNameProblem(
  typed: string,
  fallback: string,
  cwd: string,
  idf: boolean,
): string | undefined {
  const dir = typed.trim() ? formatTargetDir(typed) : fallback
  return dir ? targetDirProblem(dir, cwd, idf) : 'Project name is required'
}
