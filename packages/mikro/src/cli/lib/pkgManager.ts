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

/** Reconstruct the command the user originally ran, for "re-run" hints.
 *  Invocations through a package.json script (`pnpm dev app.ts`) render as
 *  pm + script name + the args after the mikro subcommand; anything else
 *  falls back to a direct `mikro <args>` invocation for the given pm. */
export function rerunCommand(pm: PkgManager): string {
  const args = process.argv.slice(2)
  const script = process.env.npm_lifecycle_event
  // npx/npm exec set npm_lifecycle_event to the literal "npx".
  if (script !== undefined && script !== 'npx') {
    const scriptPm = pmFromUserAgent() ?? pm
    const extras = args.slice(1)
    const run =
      scriptPm === 'npm'
        ? ['npm', 'run', script, ...(extras.length > 0 ? ['--'] : [])]
        : scriptPm === 'bun'
          ? ['bun', 'run', script]
          : [scriptPm, script]
    return [...run, ...extras].join(' ')
  }
  return mikroCommand(pm, args.join(' '))
}

/** The pm that actually invoked this process, from its user-agent env var. */
function pmFromUserAgent(): PkgManager | undefined {
  const name = process.env.npm_config_user_agent?.split('/')[0]
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : undefined
}

/** Render an "install latest version of <pkg>" command appropriate for the pm. */
export function installLatestCommand(pm: PkgManager, pkg: string): string {
  const verb = pm === 'npm' ? 'install' : 'add'
  return `${pm} ${verb} ${pkg}@latest`
}

/** Render an "install a specific version of <pkg>" command appropriate for the pm. */
export function installVersionCommand(pm: PkgManager, pkg: string, version: string): string {
  const verb = pm === 'npm' ? 'install' : 'add'
  return `${pm} ${verb} ${pkg}@${version}`
}
