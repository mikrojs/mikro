import preset from 'conventional-changelog-conventionalcommits'
import {CommitParser} from 'conventional-commits-parser'

import {git} from './repo.js'

export interface ParsedCommit {
  type: string | null
  scope: string | null
  subject: string | null
  breaking: boolean
  header: string | null
  body: string | null
  hash: string
  shortHash: string
  prNumber: number | null
}

const PR_RE = /\(#(\d+)\)\s*$/
const COMMIT_SEP = '\x1e'
const FIELD_SEP = '\x1f'

// The default parser regex doesn't accept `type(scope)!:` (Conventional
// Commits v1.0.0 syntax for breaking changes), so type/scope/subject all
// come back null and breaking commits silently disappear from the
// changelog. Load the conventionalcommits preset's parserOpts so the
// `!` is recognized.
// Upstream issue (open since 2020):
//   https://github.com/conventional-changelog/conventional-changelog/issues/648
const parser = new CommitParser((await preset()).parser)

export function parseCommit(hash: string, shortHash: string, message: string): ParsedCommit {
  const parsed = parser.parse(message)

  const subject = parsed.subject ?? null
  const prMatch = subject ? PR_RE.exec(subject) : null
  const cleanSubject = subject && prMatch ? subject.slice(0, prMatch.index).trim() : subject
  const prNumber = prMatch?.[1] ? Number(prMatch[1]) : null

  const breaking = parsed.notes.some((n) => /BREAKING/i.test(n.title))

  return {
    type: (parsed.type as string | undefined) ?? null,
    scope: (parsed.scope as string | undefined) ?? null,
    subject: cleanSubject,
    breaking,
    header: parsed.header,
    body: parsed.body,
    hash,
    shortHash,
    prNumber,
  }
}

export function getCommitsSince(ref: string | null): ParsedCommit[] {
  const range = ref ? `${ref}..HEAD` : 'HEAD'
  const fmt = `%H${FIELD_SEP}%h${FIELD_SEP}%B${COMMIT_SEP}`
  const out = git(`git log --no-merges --pretty=format:${fmt} ${range}`)
  if (!out) return []

  const commits: ParsedCommit[] = []
  for (const block of out.split(COMMIT_SEP)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const [hash, shortHash, ...rest] = trimmed.split(FIELD_SEP)
    if (!hash || !shortHash) continue
    commits.push(parseCommit(hash, shortHash, rest.join(FIELD_SEP)))
  }
  return commits
}

function versionAt(ref: string): string | null {
  let raw: string
  try {
    raw = git(`git show ${ref}:package.json`)
  } catch {
    return null // no parent commit, or no package.json at that ref
  }
  return (JSON.parse(raw) as {version?: string}).version ?? null
}

// The base for changelogs and bump recommendations: the commit that set the
// root package.json to its current version, i.e. the latest release-PR merge.
// Derived from history instead of release tags because release.yml pushes the
// tag only after a successful publish, minutes after the merge; a tag-derived
// range recomputed in that window re-lists already-released commits.
export function findReleaseBase(): string | null {
  // -G narrows to commits whose diff touches a version-shaped line; the
  // parent comparison decides.
  const out = git(`git log --format=%H -G'"version":' -- package.json`)
  for (const sha of out ? out.split('\n') : []) {
    if (versionAt(sha) !== versionAt(`${sha}^`)) return sha
  }
  return null
}
