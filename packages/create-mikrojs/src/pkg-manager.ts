export type PkgManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export function detectPkgManager(): PkgManager {
  const userAgent = process.env.npm_config_user_agent
  if (userAgent?.startsWith('pnpm/')) return 'pnpm'
  if (userAgent?.startsWith('yarn/')) return 'yarn'
  if (userAgent?.startsWith('bun/')) return 'bun'
  return 'npm'
}

export function installCommand(pm: PkgManager): string {
  return `${pm} install`
}

export function runCommand(pm: PkgManager, script: string): string {
  if (pm === 'npm' || pm === 'bun') return `${pm} run ${script}`
  return `${pm} ${script}`
}

export function mikroCommand(pm: PkgManager, cmd: string): string {
  if (pm === 'npm') return `npx mikro ${cmd}`
  if (pm === 'bun') return `bunx mikro ${cmd}`
  return `${pm} mikro ${cmd}`
}
