import {git} from './repo.js'

export interface GitInfo {
  commitHash: string
  commitCount: string
}

export function readGitInfo(): GitInfo {
  const commitHash = git('git rev-parse --short HEAD')

  let commitCount: string
  try {
    const tagInfo = git('git describe --tags --long --first-parent')
    const match = tagInfo.match(/^.+-(\d+)-g[0-9a-f]+$/)
    commitCount = match?.[1] ?? '0'
  } catch {
    // no tags yet — count all commits
    commitCount = git('git rev-list --count HEAD')
  }

  return {commitHash, commitCount}
}
