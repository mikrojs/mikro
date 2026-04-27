import {readFileSync} from 'node:fs'

export interface PullRequestEventPayload {
  action?: string
  pull_request?: {
    number: number
    merged?: boolean
    state?: string
    head?: {
      ref?: string
      repo?: {full_name?: string} | null
    }
    base?: {
      repo?: {full_name?: string} | null
    }
    labels?: Array<{name: string}>
  }
  label?: {name: string}
  repository?: {full_name?: string}
}

export interface WorkflowDispatchPayload {
  inputs?: {mode?: string; dry_run?: string}
}

export type EventPayload = PullRequestEventPayload & WorkflowDispatchPayload

export interface GhEnv {
  eventName: string | undefined
  eventPath: string | undefined
  payload: EventPayload
}

export function readGitHubEvent(): GhEnv {
  const eventName = process.env.GITHUB_EVENT_NAME
  const eventPath = process.env.GITHUB_EVENT_PATH
  let payload: EventPayload = {}
  if (eventPath) {
    try {
      payload = JSON.parse(readFileSync(eventPath, 'utf-8'))
    } catch {
      payload = {}
    }
  }
  return {eventName, eventPath, payload}
}

export function isSameRepoPr(payload: PullRequestEventPayload): boolean {
  const head = payload.pull_request?.head?.repo?.full_name
  const repo = payload.repository?.full_name ?? payload.pull_request?.base?.repo?.full_name
  return Boolean(head && repo && head === repo)
}

export function hasLabel(payload: PullRequestEventPayload, name: string): boolean {
  return Boolean(payload.pull_request?.labels?.some((l) => l.name === name))
}
