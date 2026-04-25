import {
  agentEmit,
  agentError,
  agentResult,
  createAgentStdinReader,
  forwardSessionToAgent,
  type NextAction,
} from '../agent.js'
import {openSession, type SessionHandles} from './openSession.js'

export interface AgentReplHooks {
  /** Command name used in agentError / agentResult envelopes. */
  command: 'dev' | 'console'
  /** Ran after openSession + session-to-agent forwarding is set up, before
   *  the stdin command loop starts. A thrown error triggers agentError +
   *  process.exit(1). */
  onReady?: (handles: SessionHandles) => Promise<void>
  /** Handler for an `{type: 'deploy', force?: boolean}` stdin message.
   *  No-op if absent. */
  onDeploy?: (force: boolean, handles: SessionHandles) => void
  /** Appended to the `agentResult` terminal envelope on exit. */
  nextActions?: NextAction[]
  /** Ran on every exit path (stdin 'exit', SIGINT, SIGTERM). */
  onDispose?: () => void
}

/**
 * Shared agent-mode orchestrator for the long-running REPL commands
 * (`dev`, `console`). Owns:
 *
 * - device connect via {@link openSession}
 * - session → agent NDJSON forwarding
 * - SIGINT / SIGTERM / process.on('exit') cleanup
 * - the stdin command loop (eval / directive / complete / restart / deploy / exit)
 *
 * Per-command behavior slots in via the `hooks` object.
 */
export async function runAgentRepl<T extends {port?: string; recover?: boolean}>(
  config: T,
  hooks: AgentReplHooks,
): Promise<never> {
  const handles = await openSession({
    port: config.port,
    recover: config.recover === true,
    onConnecting: (path) => {
      agentEmit({type: 'connecting', path})
      if (config.recover === true) {
        agentEmit({type: 'raw', text: 'Triggering safe mode...\n'})
      }
    },
  })
  const {session} = handles

  forwardSessionToAgent(session)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    hooks.onDispose?.()
    handles.close()
  }

  // Register dispose before onReady so an initial-deploy failure still
  // closes the serial on the exit-with-error path.
  process.on('exit', dispose)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  try {
    await hooks.onReady?.(handles)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    agentError(hooks.command, msg, {fix: 'Check device connection and try again'})
    process.exit(1)
  }

  for await (const cmd of createAgentStdinReader()) {
    switch (cmd.type) {
      case 'eval':
        if (typeof cmd.code === 'string') session.eval(cmd.code)
        break
      case 'directive':
        if (typeof cmd.code === 'string') session.directive(cmd.code)
        break
      case 'complete':
        if (typeof cmd.partial === 'string') session.complete(cmd.partial)
        break
      case 'restart':
        session.restart()
        break
      case 'deploy':
        hooks.onDeploy?.(cmd.force === true, handles)
        break
      case 'exit':
        session.exit()
        dispose()
        agentResult(hooks.command, null, hooks.nextActions)
        process.exit(0)
    }
  }

  // stdin closed without an explicit 'exit' — treat as clean exit.
  dispose()
  agentResult(hooks.command, null, hooks.nextActions)
  process.exit(0)
}
