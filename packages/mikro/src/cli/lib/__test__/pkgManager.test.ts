import {afterEach, describe, expect, it, vi} from 'vitest'

import {rerunCommand} from '../pkgManager.js'

const originalArgv = process.argv

function stubInvocation(opts: {argv: string[]; lifecycleEvent?: string; userAgent?: string}): void {
  process.argv = ['/usr/bin/node', '/path/to/mikro', ...opts.argv]
  vi.stubEnv('npm_lifecycle_event', opts.lifecycleEvent)
  vi.stubEnv('npm_config_user_agent', opts.userAgent)
}

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
})

describe('rerunCommand', () => {
  it('renders pm + script name + trailing args when run via a package.json script', () => {
    stubInvocation({
      argv: ['dev', 'app/debug/wifi.ts'],
      lifecycleEvent: 'dev',
      userAgent: 'pnpm/10.30.1 npm/? node/v24.0.0 darwin arm64',
    })
    expect(rerunCommand('pnpm')).to.equal('pnpm dev app/debug/wifi.ts')
  })

  it('prefers the invoking pm from the user agent over the detected pm', () => {
    stubInvocation({
      argv: ['dev'],
      lifecycleEvent: 'dev',
      userAgent: 'yarn/1.22.0 npm/? node/v24.0.0 darwin arm64',
    })
    expect(rerunCommand('npm')).to.equal('yarn dev')
  })

  it('uses "npm run <script> --" for npm-run scripts with trailing args', () => {
    stubInvocation({
      argv: ['dev', 'app.ts'],
      lifecycleEvent: 'dev',
      userAgent: 'npm/11.0.0 node/v24.0.0 darwin arm64 workspaces/false',
    })
    expect(rerunCommand('npm')).to.equal('npm run dev -- app.ts')
  })

  it('uses "bun run <script>" for bun-run scripts', () => {
    stubInvocation({
      argv: ['dev', 'app.ts'],
      lifecycleEvent: 'dev',
      userAgent: 'bun/1.3.0 npm/? node/v24.0.0 darwin arm64',
    })
    expect(rerunCommand('bun')).to.equal('bun run dev app.ts')
  })

  it('treats the npx lifecycle event as a direct invocation', () => {
    stubInvocation({
      argv: ['dev', 'app.ts'],
      lifecycleEvent: 'npx',
      userAgent: 'npm/11.0.0 node/v24.0.0 darwin arm64 workspaces/false',
    })
    expect(rerunCommand('npm')).to.equal('npx mikro dev app.ts')
  })

  it('falls back to a mikro invocation with the full argv when not run via a script', () => {
    stubInvocation({argv: ['deploy', '--yes']})
    expect(rerunCommand('pnpm')).to.equal('pnpm mikro deploy --yes')
  })
})
