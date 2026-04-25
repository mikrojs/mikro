/**
 * Shared helper for creating a simulator ReplSession.
 *
 * Used by all `mikro sim *` commands: spawns the simulator subprocess,
 * wraps it as a Transport, and creates a ReplSession via connectRepl.
 */

import {connectRepl, type ReplSession} from './session.js'
import type {ResolvedSimConfig} from './simConfig.js'
import {createSimTransport} from './simTransport.js'
import type {Transport} from './transport.js'

export interface ConnectSimOptions {
  /** Path to project directory containing sim/ stub overrides. */
  simDir?: string
  /** Override mem limit (only used by `mikro sim profile`). */
  memLimitOverride?: number
}

export interface SimConnection {
  session: ReplSession
  transport: Transport
}

export function connectSim(sim: ResolvedSimConfig, options: ConnectSimOptions = {}): SimConnection {
  const transport = createSimTransport({
    fsRoot: sim.fsRoot,
    memLimit: options.memLimitOverride ?? sim.memLimit,
    fsLimit: sim.fsLimit,
    fsReadMax: sim.fsReadMax,
    simDir: options.simDir,
  })
  const session = connectRepl(transport)
  return {session, transport}
}
