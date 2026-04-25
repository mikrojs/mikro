/**
 * Pid file management for the simulator.
 *
 * One sim process at a time per project. Long-lived commands (`mikro sim dev`,
 * `mikro sim repl`) claim the pid file and kill any predecessor. Short-lived
 * commands (`mikro sim deploy`, `mikro sim test`, etc.) check the pid file
 * and refuse to run if a sim is already alive — they would race on sim-fs
 * writes or yank files out from under the running process.
 */

import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs'
import * as pathlib from 'node:path'

const PID_FILE = 'sim.pid'

function pidPath(mikroDir: string): string {
  return pathlib.join(mikroDir, PID_FILE)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}

export function readPid(mikroDir: string): number | null {
  const file = pidPath(mikroDir)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8').trim()
    const pid = parseInt(raw, 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    if (!isAlive(pid)) {
      try {
        unlinkSync(file)
      } catch {}
      return null
    }
    return pid
  } catch {
    return null
  }
}

export function clearPid(mikroDir: string): void {
  const file = pidPath(mikroDir)
  try {
    unlinkSync(file)
  } catch {}
}

export class SimAlreadyRunningError extends Error {
  pid: number
  constructor(pid: number) {
    super(
      `a sim is already running (pid ${pid}). Stop it with Ctrl-C in that terminal, then try again.`,
    )
    this.name = 'SimAlreadyRunningError'
    this.pid = pid
  }
}

/**
 * Refuse to proceed if a sim is already running. Used by short-lived commands
 * (deploy, test, env, profile, clean, reset).
 */
export function checkPid(mikroDir: string): void {
  const pid = readPid(mikroDir)
  if (pid !== null) throw new SimAlreadyRunningError(pid)
}

/**
 * Claim the pid file for this process. If a predecessor is alive, kill it
 * first (SIGTERM, then SIGKILL after a short grace period). Registers exit
 * cleanup to remove the file on normal termination.
 *
 * Used by long-lived commands (dev, repl).
 */
export async function claimPid(mikroDir: string): Promise<void> {
  const file = pidPath(mikroDir)
  const existing = readPid(mikroDir)
  if (existing !== null) {
    try {
      process.kill(existing, 'SIGTERM')
    } catch {}
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && isAlive(existing)) {
      await new Promise((r) => setTimeout(r, 50))
    }
    if (isAlive(existing)) {
      try {
        process.kill(existing, 'SIGKILL')
      } catch {}
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  writeFileSync(file, String(process.pid))

  const cleanup = () => clearPid(mikroDir)
  process.once('exit', cleanup)
  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
}
