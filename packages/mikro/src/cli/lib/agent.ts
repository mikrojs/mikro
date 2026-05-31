import {createInterface} from 'node:readline'

import type {Subscription} from 'rxjs'
import {isAgent} from 'std-env'

import type {ReplSession} from './session.js'

export interface NextAction {
  command: string
  description: string
}

/**
 * Check if agent mode is active via --agent flag or AI agent environment detection.
 */
export function isAgentMode(flagValue?: boolean): boolean {
  return flagValue === true || isAgent
}

/**
 * Emit a single NDJSON event to stdout.
 */
export function agentEmit(event: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

/**
 * Emit a terminal success envelope.
 */
export function agentResult(command: string, result: unknown, nextActions?: NextAction[]) {
  agentEmit({
    type: 'result',
    ok: true,
    command,
    result,
    ...(nextActions ? {next_actions: nextActions} : {}),
  })
}

/**
 * Emit a terminal error envelope.
 */
export function agentError(
  command: string,
  error: string,
  options?: {fix?: string; next_actions?: NextAction[]},
) {
  agentEmit({
    type: 'error',
    ok: false,
    command,
    error,
    ...(options?.fix ? {fix: options.fix} : {}),
    ...(options?.next_actions ? {next_actions: options.next_actions} : {}),
  })
}

/**
 * Subscribe the session's message stream to the agent NDJSON protocol.
 * Emits ready/raw/log/warn/error/info/debug/result/eval_error events and
 * silently drops prompt and disconnect. Returns the Subscription so callers
 * can tear it down.
 */
export function forwardSessionToAgent(session: ReplSession): Subscription {
  return session.messages$.subscribe((event) => {
    switch (event.type) {
      case 'ready':
        agentEmit({type: 'ready', chip: event.chip ?? null, id: event.id ?? null})
        break
      case 'raw':
        agentEmit({type: 'raw', text: event.text})
        break
      case 'prompt':
      case 'disconnect':
        break
      default:
        if ('text' in event) agentEmit({type: event.type, text: event.text})
        break
    }
  })
}

/**
 * Read NDJSON commands from stdin. Yields parsed JSON objects.
 * Silently skips malformed lines.
 */
export async function* createAgentStdinReader(): AsyncIterable<Record<string, unknown>> {
  const rl = createInterface({input: process.stdin, crlfDelay: Infinity})
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) {
        yield parsed as Record<string, unknown>
      }
    } catch {
      // skip malformed lines
    }
  }
}
