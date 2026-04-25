/**
 * High-level helper for opening a sim session from a `mikro sim *` command.
 *
 * - Long-lived commands (`sim dev`, `sim repl`) pass `claim: true` to write
 *   the pid file and kill any predecessor.
 * - Short-lived commands (`sim deploy`, `sim test`, `sim env`, `sim profile`,
 *   `sim clean`, `sim reset`) pass `claim: false` (the default) to refuse if
 *   a sim is already running.
 *
 * Loads the project's `mikro.config.ts` (if any) to resolve the sim section,
 * then connects via `connectSim`.
 */

import {connectSim, type SimConnection} from './connectSim.js'
import {getMikroDir} from './projectRoot.js'
import {loadSimConfig, type ResolvedSimConfig} from './simConfig.js'
import {checkPid, claimPid} from './simPid.js'

export interface OpenSimOptions {
  /** Long-lived command: claim the pid file (kills predecessor). Default false. */
  claim?: boolean
  /** Directory to start `mikro.config.ts` lookup from. Defaults to cwd. */
  startDir?: string
  /** Override mem limit. Used by `mikro sim profile` for its high ceiling. */
  memLimitOverride?: number
  /** Path to project directory containing `sim/` stub overrides. */
  simDir?: string
}

export interface OpenSimResult extends SimConnection {
  sim: ResolvedSimConfig
}

export async function openSim(options: OpenSimOptions = {}): Promise<OpenSimResult> {
  const mikroDir = getMikroDir()
  if (options.claim) {
    await claimPid(mikroDir)
  } else {
    checkPid(mikroDir)
  }
  const sim = await loadSimConfig(options.startDir)
  const conn = connectSim(sim, {
    memLimitOverride: options.memLimitOverride,
    simDir: options.simDir,
  })
  return {...conn, sim}
}
