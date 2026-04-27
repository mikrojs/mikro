import {execSync} from 'node:child_process'
import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {MONOREPO_ROOT} from './repo.js'

export interface PnpmPackage {
  name: string
  version: string
  path: string
  private: boolean
}

function listAllWorkspacePackages(): PnpmPackage[] {
  const output = execSync('pnpm ls -r --json --depth -1', {
    cwd: MONOREPO_ROOT,
    encoding: 'utf-8',
  })
  return JSON.parse(output)
}

// The set of packages that ship to npm in lockstep. Excludes:
//  - the workspace root (mikrojs-workspace) and any other `private: true` package
//  - internal `@repo/*` packages used only for tooling
export function getPublishablePackages(): PnpmPackage[] {
  return listAllWorkspacePackages().filter(
    (pkg) => pkg.private !== true && !pkg.name.startsWith('@repo/'),
  )
}

// The canonical version shared by all publishable packages. Throws if they
// have diverged — lockstep is a hard invariant of the release flow.
export function readCanonicalVersion(): string {
  const pkgs = getPublishablePackages()
  if (pkgs.length === 0) {
    throw new Error('No publishable packages found in workspace')
  }
  const version = pkgs[0]!.version
  const diverged = pkgs.filter((p) => p.version !== version)
  if (diverged.length > 0) {
    const lines = pkgs.map((p) => `  ${p.name}: ${p.version}`).join('\n')
    throw new Error(
      `Publishable packages are not in lockstep:\n${lines}\nFix all to the same version before releasing.`,
    )
  }
  // High-signal log: makes it obvious in CI which packages contributed to
  // the canonical version. Past bug: we used to read from workspace root
  // (always 0.0.0), which silently produced wrong releases.
  // eslint-disable-next-line no-console
  console.error(
    `[releaser] canonical version ${version} from ${pkgs.length} packages: ${pkgs.map((p) => p.name).join(', ')}`,
  )
  return version
}

export function writeVersion(packagePath: string, newVersion: string): void {
  const pkgJsonPath = join(packagePath, 'package.json')
  const content = readFileSync(pkgJsonPath, 'utf-8')
  const pkg = JSON.parse(content)
  pkg.version = newVersion
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
}
