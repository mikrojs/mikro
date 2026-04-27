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

function readPackageVersion(packagePath: string): string {
  const pkgJsonPath = join(packagePath, 'package.json')
  return JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version
}

// Workspace root tracks the canonical version. `bump` keeps root in lockstep
// with all publishable packages, so anyone inspecting `package.json` sees the
// current shipped version even though root itself isn't published.
export function readCanonicalVersion(): string {
  const rootVersion = readPackageVersion(MONOREPO_ROOT)
  const pkgs = getPublishablePackages()
  if (pkgs.length === 0) {
    throw new Error('No publishable packages found in workspace')
  }
  const diverged = pkgs.filter((p) => p.version !== rootVersion)
  if (diverged.length > 0) {
    const lines = [
      `  <root>: ${rootVersion}`,
      ...pkgs.map((p) => `  ${p.name}: ${p.version}`),
    ].join('\n')
    throw new Error(
      `Workspace is not in lockstep:\n${lines}\nFix all to the same version before releasing.`,
    )
  }
  // High-signal CI log: makes it obvious which packages contributed to the
  // canonical version. Past bug: we used to read from a marker version,
  // which silently produced wrong releases.
  // eslint-disable-next-line no-console
  console.error(
    `[releaser] canonical version ${rootVersion} (root + ${pkgs.length} publishable packages)`,
  )
  return rootVersion
}

export function writeVersion(packagePath: string, newVersion: string): void {
  const pkgJsonPath = join(packagePath, 'package.json')
  const content = readFileSync(pkgJsonPath, 'utf-8')
  const pkg = JSON.parse(content)
  pkg.version = newVersion
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
}
