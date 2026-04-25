import {spawn} from 'node:child_process'
import {readFileSync} from 'node:fs'
import * as pathlib from 'node:path'

import {concat, Observable} from 'rxjs'

/**
 * Read `mikrojs.predeploy` from the project's package.json. Returns an
 * empty array if the file, the `mikrojs` field, or the `predeploy` field
 * is missing. Throws on malformed `predeploy` values.
 */
export function getPredeployCommands(projectRoot: string): string[] {
  const path = pathlib.join(projectRoot, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const pkg = JSON.parse(raw) as {mikrojs?: {predeploy?: unknown}}
  const value = pkg.mikrojs?.predeploy
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  throw new Error('Invalid mikrojs.predeploy in package.json: expected string or array of strings')
}

export type HookEvent =
  | {type: 'start'; command: string}
  | {type: 'stdout'; command: string; chunk: Uint8Array}
  | {type: 'stderr'; command: string; chunk: Uint8Array}
  | {type: 'complete'; command: string}

export class HookError extends Error {
  readonly command: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  constructor(command: string, exitCode: number | null, signal: NodeJS.Signals | null) {
    const detail = signal ? `signal ${signal}` : `exit ${exitCode}`
    super(`Hook failed: ${command} (${detail})`)
    this.command = command
    this.exitCode = exitCode
    this.signal = signal
  }
}

function runHook(command: string, cwd: string): Observable<HookEvent> {
  return new Observable<HookEvent>((subscriber) => {
    const abort = new AbortController()
    // Prepend <projectRoot>/node_modules/.bin so `tsc`, `eslint`, etc.
    // resolve without requiring `npx` / `pnpm exec` in the command string.
    const binDir = pathlib.join(cwd, 'node_modules', '.bin')
    const env = {...process.env, PATH: `${binDir}${pathlib.delimiter}${process.env.PATH ?? ''}`}

    subscriber.next({type: 'start', command})

    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      signal: abort.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout?.on('data', (chunk: Uint8Array) => {
      subscriber.next({type: 'stdout', command, chunk})
    })
    child.stderr?.on('data', (chunk: Uint8Array) => {
      subscriber.next({type: 'stderr', command, chunk})
    })
    child.on('error', (err) => {
      if (abort.signal.aborted) return
      subscriber.error(err)
    })
    child.on('close', (code, signal) => {
      if (abort.signal.aborted) return
      if (code === 0) {
        subscriber.next({type: 'complete', command})
        subscriber.complete()
      } else {
        subscriber.error(new HookError(command, code, signal))
      }
    })

    return () => {
      abort.abort()
    }
  })
}

/**
 * Run `commands` sequentially, fail-fast. Unsubscribe cancels the in-flight
 * hook (via AbortController) and skips the rest.
 */
export function runHooks(commands: readonly string[], cwd: string): Observable<HookEvent> {
  return concat(...commands.map((cmd) => runHook(cmd, cwd)))
}
