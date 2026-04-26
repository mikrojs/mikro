import {preferredPM} from 'preferred-pm'

export type PkgManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

let cachedPmPromise: Promise<PkgManager> | null = null

/** Detect the package manager used in the project at `cwd`. Memoized for
 *  the lifetime of the process. Falls back to 'npm' on any error or
 *  unrecognized result. */
export function detectPreferredPm(cwd: string = process.cwd()): Promise<PkgManager> {
  cachedPmPromise ??= preferredPM(cwd)
    .then((r): PkgManager => {
      if (r?.name === 'pnpm' || r?.name === 'yarn' || r?.name === 'bun') return r.name
      return 'npm'
    })
    .catch((): PkgManager => 'npm')
  return cachedPmPromise
}

/** Render a `mikro <cmd>` invocation appropriate for the given pm. */
export function mikroCommand(pm: PkgManager, cmd: string): string {
  if (pm === 'npm') return `npx mikro ${cmd}`
  if (pm === 'bun') return `bunx mikro ${cmd}`
  return `${pm} mikro ${cmd}`
}

/** Render an "install latest version of <pkg>" command appropriate for the pm. */
export function installLatestCommand(pm: PkgManager, pkg: string): string {
  const verb = pm === 'npm' ? 'install' : 'add'
  return `${pm} ${verb} ${pkg}@latest`
}
