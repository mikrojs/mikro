import {Bumper} from 'conventional-recommended-bump'
import semver from 'semver'

import {MONOREPO_ROOT} from './repo.js'

export type ReleaseType = 'major' | 'minor' | 'patch'

export async function getRecommendedBump(): Promise<ReleaseType> {
  const bumper = new Bumper(MONOREPO_ROOT)
  bumper.loadPreset('conventionalcommits')
  bumper.tag({prefix: 'v', skipUnstable: true})
  const result = await bumper.bump()
  if ('releaseType' in result && result.releaseType) {
    return result.releaseType as ReleaseType
  }
  return 'patch'
}

export function zeroPad(value: number | string, length: number): string {
  return String(value).padStart(length, '0')
}

export function formatTimestamp(now: Date): string {
  return [
    zeroPad(now.getUTCFullYear(), 4),
    zeroPad(now.getUTCMonth() + 1, 2),
    zeroPad(now.getUTCDate(), 2),
    zeroPad(now.getUTCHours(), 2),
    zeroPad(now.getUTCMinutes(), 2),
    zeroPad(now.getUTCSeconds(), 2),
  ].join('')
}

export function computeVersion({
  currentVersion,
  semverIncrement,
  preid,
  suffix,
}: {
  currentVersion: string
  semverIncrement: ReleaseType
  preid: string | undefined
  suffix: string | undefined
}): string {
  const bumped = semver.inc(currentVersion, semverIncrement)
  if (!bumped) {
    throw new Error(`Failed to compute ${semverIncrement} version from ${currentVersion}`)
  }
  return preid ? `${bumped}-${preid}.${suffix}` : bumped
}
