import {useCallback, useMemo} from 'react'

import type {LogLevel} from '../../../_exports/index.js'
import type {ReplSession} from '../session.js'
import {ReplConsole} from './ReplConsole.js'
import {createRepl, type ReplHandle} from './replStateMachine.js'

export interface InkReplConsoleProps {
  session: ReplSession
  devicePath: string
  /** Connected device's USB serial, forwarded to `ReplConsole` for its alias. */
  serialNumber?: string
  logLevel?: LogLevel
  /** When true, the deploy keybind fires a trigger into the repl's
   *  `deploys$`. Defaults to false so callers that render a plain REPL
   *  (e.g. `deploy --console`) don't accidentally emit into a Subject
   *  no one subscribes to. `InkReplMode` sets this to `true` when a
   *  `driver` is supplied. */
  deployEnabled?: boolean
  /** Pre-built repl handle. Use when the caller already created the repl
   *  (e.g. to subscribe to its `deploys$` before handing it off). */
  repl?: ReplHandle
  /** Forwarded to `ReplConsole` for the header watch-mode badge. */
  watch?: boolean
}

/**
 * Renders a `ReplConsole` over an existing `ReplSession`. Owns the
 * Kitty-keyboard cleanup (`\x1b[<u`) and `process.exit(0)` on end.
 * Pure in the sense that it doesn't touch the serial port or open
 * a connection — feed it a live session.
 */
export function InkReplConsole(props: InkReplConsoleProps) {
  const {
    session,
    devicePath,
    serialNumber,
    logLevel,
    deployEnabled = false,
    repl: providedRepl,
    watch,
  } = props

  const handleEnd = useCallback(() => {
    process.stdout.write('\x1b[<u')
    process.exit(0)
  }, [])

  const repl = useMemo(() => {
    if (providedRepl) return providedRepl
    return createRepl({session, port: devicePath, onEnd: handleEnd, deployEnabled})
  }, [providedRepl, session, devicePath, handleEnd, deployEnabled])

  return (
    <ReplConsole
      repl={repl}
      config={session.config}
      logLevel={logLevel}
      watch={watch}
      serialNumber={serialNumber}
    />
  )
}
