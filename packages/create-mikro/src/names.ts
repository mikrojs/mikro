import path from 'node:path'

// The project argument works as in create-vite: it's the folder, and the
// package is named after the folder's last segment. Unlike create-vite, a
// scoped name (@acme/devboard) is also the package's name, since board
// packages are often scoped.

/** The folder `arg` names, without characters a folder can't have or trailing slashes. */
export function formatTargetDir(arg: string): string {
  return arg
    .trim()
    .replace(/[<>:"\\|?*]/g, '')
    .replace(/\/+$/g, '')
}

export function isValidPackageName(name: string): boolean {
  return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(name)
}

/** `name` as a valid package name, or '' when nothing usable remains. The
 *  scope and the name are cleaned separately, so a scope is never lost. */
export function toValidPackageName(name: string): string {
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name.trim())
  if (!scoped) return slug(name)
  const scope = slug(scoped[1]!)
  const bare = slug(scoped[2]!)
  return scope && bare ? `@${scope}/${bare}` : ''
}

// "My Café" → "my-cafe"
function slug(input: string): string {
  return input
    .normalize('NFKD') // decompose accents: "é" → "e" + combining mark
    .replace(/[\u0300-\u036f]/g, '') // strip the combining marks
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
}

/** The package name for the folder `targetDir`: the folder itself when it is
 *  `@scope/name`, else its last segment. Either may not be valid yet. */
export function packageNameFor(targetDir: string, cwd: string): string {
  if (/^@[^/]+\/[^/]+$/.test(targetDir)) return targetDir
  return path.basename(path.resolve(cwd, targetDir))
}
