import {execSync} from 'node:child_process'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

// Resolve monorepo root from this package's location: packages/@repo/releaser/src/util → repo root
const here = dirname(fileURLToPath(import.meta.url))
export const MONOREPO_ROOT = resolve(here, '..', '..', '..', '..', '..')

export function git(cmd: string): string {
  return execSync(cmd, {cwd: MONOREPO_ROOT, encoding: 'utf-8'}).trim()
}
