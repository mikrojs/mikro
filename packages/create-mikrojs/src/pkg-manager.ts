export type PkgManager = 'npm' | 'pnpm'

export function detectPkgManager(): PkgManager {
  const userAgent = process.env.npm_config_user_agent
  if (userAgent?.startsWith('pnpm/')) return 'pnpm'
  return 'npm'
}

export function installCommand(pm: PkgManager): string {
  return `${pm} install`
}

export function runCommand(pm: PkgManager, script: string): string {
  if (pm === 'npm') return `npm run ${script}`
  return `pnpm ${script}`
}
