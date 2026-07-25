import {homedir} from 'node:os'
import * as pathlib from 'node:path'

/** A path as a reader would recognize it: relative to the working directory when
 *  it is under it, `~/…` when it is under home, absolute otherwise. Output lines
 *  carrying a full build path wrap on a normal terminal, and the leading
 *  `/Users/<name>/…` is the part nobody needs. */
export function displayPath(path: string): string {
  const relative = pathlib.relative(process.cwd(), path)
  if (relative !== '' && !relative.startsWith('..')) return relative
  const home = homedir()
  return path.startsWith(home + pathlib.sep) ? `~${path.slice(home.length)}` : path
}
