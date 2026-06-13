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

function zeroPad(value: number | string, length: number): string {
  return String(value).padStart(length, '0')
}

// Compact UTC wall-clock stamp (yyyymmddHHMMSS), e.g. 20260613094217. Used as
// the prerelease counter in every prerelease mode: monotonically increasing
// across publishes with no registry or git state to consult.
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

// The version as it appears on the registry: pnpm strips build metadata at
// publish (pnpm#11518), so local versions (which carry `+sha`) must be
// stripped before any registry lookup or comparison against published ones.
export function stripBuildMetadata(version: string): string {
  const plus = version.indexOf('+')
  return plus === -1 ? version : version.slice(0, plus)
}

export function computeVersion({
  currentVersion,
  semverIncrement,
  preid,
  suffix,
  build,
  breakingIsMinorOn0x,
  noIncrement,
}: {
  currentVersion: string
  semverIncrement: ReleaseType
  preid: string | undefined
  suffix: string | undefined
  // Build metadata (`+<build>`), used to carry the commit sha. It is written
  // to package.json (and from there baked into firmware), but pnpm strips it
  // at publish (pnpm#11518), so the registry only ever sees the bare
  // prerelease version. Ignored by semver precedence.
  build?: string
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
  // Single source for the prerelease format. Keep `canary`, `pr-N`, and
  // `release-preview` all routed through here so the shape can't drift
  // between modes.
  if (!preid) return base
  return `${base}-${preid}.${suffix}${build ? `+${build}` : ''}`
}
