import type {ParsedCommit} from './commits.js'

const SECTIONS: Array<{title: string; types: string[]}> = [
  {title: 'Breaking changes', types: []},
  {title: 'Features', types: ['feat']},
  {title: 'Bug fixes', types: ['fix']},
  {title: 'Performance', types: ['perf']},
  {title: 'Other', types: ['refactor', 'docs', 'chore', 'build', 'ci', 'test', 'style', 'revert']},
]

// Backslash-escape angle brackets so commit subjects like
// `cli: handle <Ctrl+C>` don't get HTML-interpreted by GitHub's markdown
// renderer (which would silently swallow `<Ctrl+C>` as an unknown tag).
// CommonMark/GFM treats `\<` and `\>` as literal characters.
export function escapeMarkdown(s: string): string {
  return s.replace(/[<>]/g, (m) => `\\${m}`)
}

function repoUrl(): string {
  const slug = process.env.GITHUB_REPOSITORY
  return slug ? `https://github.com/${slug}` : ''
}

function commitLine(c: ParsedCommit): string {
  const subject = escapeMarkdown(c.subject ?? c.header ?? c.shortHash)
  const scope = c.scope ? `**${escapeMarkdown(c.scope)}:** ` : ''
  const url = repoUrl()
  const ref = url
    ? c.prNumber
      ? `([#${c.prNumber}](${url}/pull/${c.prNumber}))`
      : `([${c.shortHash}](${url}/commit/${c.hash}))`
    : c.prNumber
      ? `(#${c.prNumber})`
      : `(${c.shortHash})`
  return `- ${scope}${subject} ${ref}`
}

export function formatChangelog(commits: ParsedCommit[]): string {
  const conventional = commits.filter((c) => c.type !== null)
  if (conventional.length === 0) return '_No notable changes._\n'

  const breaking = conventional.filter((c) => c.breaking)
  const lines: string[] = []

  for (const section of SECTIONS) {
    const matched =
      section.title === 'Breaking changes'
        ? breaking
        : conventional.filter((c) => c.type && section.types.includes(c.type) && !c.breaking)
    if (matched.length === 0) continue
    lines.push(`### ${section.title}`, '')
    for (const c of matched) lines.push(commitLine(c))
    lines.push('')
  }

  return lines.join('\n')
}
