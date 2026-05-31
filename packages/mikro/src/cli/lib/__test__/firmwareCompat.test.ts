import {createRequire} from 'node:module'

import {describe, expect, it} from 'vitest'

import {
  checkFirmwareCompat,
  formatAdvisory,
  formatBestEffortWarning,
  formatIncompatibleError,
} from '../firmwareCompat.js'

const require = createRequire(import.meta.url)
const cliVersion = (require('../../../../package.json') as {version: string}).version

describe('checkFirmwareCompat', () => {
  it('returns "match" when device matches the CLI version exactly', () => {
    const result = checkFirmwareCompat(cliVersion)
    expect(result.status).to.equal('match')
    expect(result.direction).to.be.null
    expect(result.deviceVersion).to.equal(cliVersion)
    expect(result.cliVersion).to.equal(cliVersion)
  })

  it('returns "incompatible" when device reports no version', () => {
    const result = checkFirmwareCompat(null)
    expect(result.status).to.equal('incompatible')
    expect(result.deviceVersion).to.be.null
  })

  it('returns "incompatible" for a wildly higher major version', () => {
    const result = checkFirmwareCompat('99.0.0')
    expect(result.status).to.equal('incompatible')
  })

  it('accepts a prerelease device version that falls within the CLI range', () => {
    // Build a prerelease at the same major.minor as the CLI so the only thing
    // that could exclude it is semver's default prerelease handling.
    const [maj, min] = cliVersion.split('.')
    const prerelease = `${maj}.${min}.99-pr-14.20260427170853+abc1234`
    const result = checkFirmwareCompat(prerelease)
    expect(result.status).to.not.equal('incompatible')
  })

  it('exposes a required range derived from the CLI version', () => {
    const result = checkFirmwareCompat(cliVersion)
    expect(result.requiredRange).to.match(/^\^/)
  })
})

describe('formatAdvisory', () => {
  it('formats the device-older message', () => {
    const result = checkFirmwareCompat(cliVersion)
    // Force a synthetic update_available result to test formatting independent of CLI version.
    const synthetic = {
      ...result,
      status: 'update_available' as const,
      direction: 'device_older' as const,
      deviceVersion: '1.0.0',
      cliVersion: '1.2.0',
    }
    const msg = formatAdvisory(synthetic, 'pnpm')
    expect(msg).to.contain('device is running mikrojs v1.0.0')
    expect(msg).to.contain('your project uses v1.2.0')
    expect(msg).to.contain('pnpm mikro flash')
  })

  it('formats the device-newer message', () => {
    const result = checkFirmwareCompat(cliVersion)
    const synthetic = {
      ...result,
      status: 'update_available' as const,
      direction: 'device_newer' as const,
      deviceVersion: '1.2.0',
      cliVersion: '1.0.0',
    }
    const msg = formatAdvisory(synthetic, 'pnpm')
    expect(msg).to.contain('your project uses mikrojs v1.0.0')
    expect(msg).to.contain('device is running v1.2.0')
    expect(msg).to.contain('pnpm add mikro@latest')
  })

  it('renders pm-specific commands', () => {
    const synthetic = {
      status: 'update_available' as const,
      direction: 'device_older' as const,
      deviceVersion: '1.0.0',
      cliVersion: '1.2.0',
      requiredRange: '^1.0.0',
    }
    expect(formatAdvisory(synthetic, 'npm')).to.contain('npx mikro flash')
    expect(formatAdvisory(synthetic, 'pnpm')).to.contain('pnpm mikro flash')
    expect(formatAdvisory(synthetic, 'yarn')).to.contain('yarn mikro flash')
    expect(formatAdvisory(synthetic, 'bun')).to.contain('bunx mikro flash')
  })
})

describe('formatIncompatibleError', () => {
  it('formats a message with the pm-specific update command', () => {
    const result = checkFirmwareCompat('99.0.0')
    const msg = formatIncompatibleError(result, 'pnpm')
    expect(msg).to.contain('v99.0.0')
    expect(msg).to.contain('pnpm mikro flash')
  })

  it('handles missing device version', () => {
    const result = checkFirmwareCompat(null)
    const msg = formatIncompatibleError(result, 'npm')
    expect(msg).to.contain('vunknown')
    expect(msg).to.contain('npx mikro flash')
  })
})

describe('formatBestEffortWarning', () => {
  it('suggests installing a matching CLI version when the device reported one', () => {
    const result = checkFirmwareCompat('0.5.0')
    const msg = formatBestEffortWarning(result, 'pnpm')
    expect(msg).to.contain('v0.5.0')
    expect(msg).to.contain('Attempting anyway')
    expect(msg).to.contain('pnpm add mikro@0.5.0')
    expect(msg).to.contain('pnpm mikro flash')
  })

  it('only suggests reflashing when the device reported no version', () => {
    const result = checkFirmwareCompat(null)
    const msg = formatBestEffortWarning(result, 'npm')
    expect(msg).to.contain('did not report a version')
    expect(msg).to.contain('npx mikro flash')
    expect(msg).to.not.contain('mikro@')
  })
})
