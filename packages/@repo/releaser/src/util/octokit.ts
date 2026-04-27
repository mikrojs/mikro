import {Octokit} from '@octokit/rest'

let cached: Octokit | null = null

export function octokit(): Octokit {
  if (cached) return cached
  const auth = process.env.GITHUB_TOKEN
  if (!auth) {
    throw new Error('GITHUB_TOKEN is required')
  }
  cached = new Octokit({auth})
  return cached
}

export function repoSlug(): {owner: string; repo: string} {
  const slug = process.env.GITHUB_REPOSITORY
  if (!slug) throw new Error('GITHUB_REPOSITORY is required')
  const [owner, repo] = slug.split('/')
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${slug}`)
  return {owner, repo}
}
