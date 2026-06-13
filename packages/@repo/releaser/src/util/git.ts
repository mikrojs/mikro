import {git} from './repo.js'

export interface GitInfo {
  commitHash: string
}

export function readGitInfo(): GitInfo {
  return {commitHash: git('git rev-parse --short HEAD')}
}
