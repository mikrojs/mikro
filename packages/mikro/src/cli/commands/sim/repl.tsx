import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag} from '@optique/core/primitives'
import {Text} from 'ink'
import React, {useCallback, useEffect, useState} from 'react'

import {agentEmit, agentResult, createAgentStdinReader} from '../../lib/agent.js'
import {openSim, type OpenSimResult} from '../../lib/openSim.js'
import {ReplConsole} from '../../lib/serial/ReplConsole.js'
import {createRepl} from '../../lib/serial/replStateMachine.js'
import {SimAlreadyRunningError} from '../../lib/simPid.js'

export const args = command(
  'repl',
  object({
    subcommand: constant('repl' as const),
    agent: optional(flag('--agent', {description: message`NDJSON agent protocol over stdio`})),
  }),
  {description: message`Open an interactive REPL on the simulator`},
)

interface ReplConfig {
  agent?: boolean
}

export async function run(_config: ReplConfig): Promise<void> {
  let session
  let transport
  try {
    const conn = await openSim({claim: true})
    session = conn.session
    transport = conn.transport
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      // eslint-disable-next-line no-console
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  agentEmit({type: 'connecting', path: 'simulator'})

  session.messages$.subscribe((event) => {
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

  process.on('exit', () => session.close())
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

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
      case 'exit':
        session.exit()
        session.close()
        transport.close()
        agentResult('sim repl', null, [])
        process.exit(0)
    }
  }
}

export default function SimRepl(_props: {args: ReplConfig}) {
  const handleEnd = useCallback(() => {
    process.stdout.write('\x1b[<u')
    process.exit(0)
  }, [])
  return <SimReplSession onEnd={handleEnd} />
}

function SimReplSession({onEnd}: {onEnd: () => void}) {
  const [state, setState] = useState<
    {conn: OpenSimResult; replHandle: ReturnType<typeof createRepl>} | Error | null
  >(null)

  useEffect(() => {
    let disposed = false
    openSim({claim: true}).then(
      (conn) => {
        if (disposed) {
          conn.session.close()
          conn.transport.close()
          return
        }
        const replHandle = createRepl({session: conn.session, port: 'simulator', onEnd})
        setState({conn, replHandle})
      },
      (err) => {
        if (!disposed) setState(err instanceof Error ? err : new Error(String(err)))
      },
    )
    return () => {
      disposed = true
      if (state && !(state instanceof Error)) {
        state.conn.session.close()
        state.conn.transport.close()
      }
    }
    // onEnd is stable; intentionally not in deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (state instanceof Error) {
    return <Text color="red">Error: {state.message}</Text>
  }
  if (!state) return null
  return <ReplConsole repl={state.replHandle} config={state.conn.session.config} />
}
