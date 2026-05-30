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

export function computeVersion({
  currentVersion,
  semverIncrement,
  preid,
  suffix,
  breakingIsMinorOn0x,
  noIncrement,
}: {
  currentVersion: string
  semverIncrement: ReleaseType
  preid: string | undefined
  suffix: string | undefined
  breakingIsMinorOn0x?: boolean
  // Base the version on `currentVersion` as-is, skipping the semver
  // increment. Used by release-preview: the rolling release PR has already
  // bumped package.json to the version about to ship, so a preview must
  // publish THAT version as a prerelease rather than bump it again.
  noIncrement?: boolean
}): string {
  let base: string
  if (noIncrement) {
    base = currentVersion
  } else {
    // Optional policy (analogous to release-please's `bump-minor-pre-major`,
    // same default: off): when set, a recommended `major` bump from
    // conventional-commits is downgraded to `minor` while the canonical
    // version is on 0.x. Off by default so a `feat!:` commit produces 1.0.0
    // from 0.x without ceremony; flip on if you want a safety net while
    // pre-major. No-op once on 1.x or later.
    const effectiveIncrement: ReleaseType =
      semverIncrement === 'major' && breakingIsMinorOn0x && semver.major(currentVersion) === 0
        ? 'minor'
        : semverIncrement
    const bumped = semver.inc(currentVersion, effectiveIncrement)
    if (!bumped) {
      throw new Error(`Failed to compute ${effectiveIncrement} version from ${currentVersion}`)
    }
    base = bumped
  }
  // Single source for the provenance-safe prerelease format. Keep `next`,
  // `canary`, `pr-N`, and `release-preview` all routed through here so the
  // shape can't drift between modes.
  return preid ? `${base}-${preid}.${suffix}` : base
}
