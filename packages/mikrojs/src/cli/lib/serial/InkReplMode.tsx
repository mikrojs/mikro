import spinners from 'cli-spinners'
import {Text, useInput} from 'ink'
import {useCallback, useEffect, useMemo, useRef} from 'react'
import {catchError, from, map, type Observable, of, shareReplay, switchMap} from 'rxjs'

import type {LogLevel} from '../../../_exports/index.js'
import {BAUD_RATE} from '../deploy.js'
import {triggerSafeMode} from '../recover.js'
import type {ReplSession} from '../session.js'
import {Spinner} from '../Spinner.js'
import {openSerial} from '../transport.js'
import {useObservable} from '../useObservable.js'
import {InkReplConsole} from './InkReplConsole.js'
import {createRepl, type ReplHandle} from './replStateMachine.js'
import {createSupervisedSession} from './supervisedSession.js'

export interface InkReplDriverContext {
  session: ReplSession
  repl: ReplHandle
  devicePath: string
}

export interface InkReplDriverResult {
  /** Observable to subscribe to for the session's lifetime. Used by `dev`
   *  to keep `createDevSession.state$` alive. */
  run$?: Observable<unknown>
  /** Cleanup ran when the component unmounts. */
  dispose?: () => void
}

export interface InkReplModeProps {
  devicePath: string
  /** Trigger safe-mode after opening the session. Used by
   *  `console --recover` / `deploy --recover`. */
  recover?: boolean
  logLevel?: LogLevel
  /** Per-command work that runs alongside the REPL. When a driver is
   *  supplied, Ctrl+S is wired up (callers typically subscribe to
   *  `repl.deploys$`). Without a driver, the deploy keybind is a no-op. */
  driver?: (ctx: InkReplDriverContext) => InkReplDriverResult
  /** Forwarded to the rendered `ReplConsole` header badge. Typically set
   *  by `dev` to reflect `--no-watch`. */
  watch?: boolean
}

/**
 * Shared Ink-mode orchestrator for `dev`, `console`, and any command
 * that wants "connect + attach REPL". Opens the serial, brings up a
 * `ReplSession`, creates a `ReplHandle`, runs the optional `driver`
 * for the session's lifetime, and renders `InkReplConsole`.
 */
export function InkReplMode(props: InkReplModeProps) {
  const {devicePath, recover = false, logLevel, driver, watch} = props

  const handleEnd = useCallback(() => {
    process.stdout.write('\x1b[<u')
    process.exit(0)
  }, [])

  const deployEnabled = Boolean(driver)

  const connection$ = useMemo(
    () =>
      openSerial(devicePath, BAUD_RATE).pipe(
        // Session is created BEFORE triggerSafeMode so the eager
        // subscription inside connectRepl is listening when the
        // post-reset MSG_READY arrives.
        switchMap((serial) => {
          const session = createSupervisedSession(serial, {devicePath, baudRate: BAUD_RATE})
          return recover ? from(triggerSafeMode(serial)).pipe(map(() => session)) : of(session)
        }),
        map((session) => {
          const repl = createRepl({
            session,
            port: devicePath,
            onEnd: handleEnd,
            deployEnabled,
          })
          return {session, repl}
        }),
        catchError((err) => of(err instanceof Error ? err : new Error(String(err)))),
        // refCount: false — the inner `switchMap` opens the serial and
        // calls `triggerSafeMode`, which must happen exactly once per
        // InkReplMode instance. With refCount: true, transient zero-
        // subscriber windows would re-run the chain on next subscribe
        // and reopen the port.
        shareReplay({bufferSize: 1, refCount: false}),
      ),
    [devicePath, recover, handleEnd, deployEnabled],
  )

  const connection = useObservable(connection$, null)
  const ready = connection && !(connection instanceof Error) ? connection : null

  // Keep `driver` in a ref so the effect below only re-runs when a new
  // session is actually available. Caller memoisation would also work,
  // but this puts the "run driver exactly once per session" contract
  // in InkReplMode rather than relying on convention.
  const driverRef = useRef(driver)
  useEffect(() => {
    driverRef.current = driver
  })

  // Run the per-command driver while the session is alive.
  useEffect(() => {
    if (!ready) return
    const spawned = driverRef.current?.({
      session: ready.session,
      repl: ready.repl,
      devicePath,
    })
    if (!spawned) return
    const sub = spawned.run$?.subscribe()
    return () => {
      sub?.unsubscribe()
      spawned.dispose?.()
    }
  }, [ready, devicePath])

  // Ctrl+C / Ctrl+Q while still connecting — the REPL's own bindings
  // take over once it's active.
  useInput(
    (_ch, key) => {
      if (key.ctrl && (_ch === 'c' || _ch === 'q')) process.exit(0)
    },
    {isActive: !ready},
  )

  if (connection instanceof Error) {
    return <Text color="red">Connection error: {connection.message}</Text>
  }
  if (!ready) {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> Connecting to {devicePath}…
      </Text>
    )
  }
  return (
    <InkReplConsole
      session={ready.session}
      devicePath={devicePath}
      logLevel={logLevel}
      repl={ready.repl}
      watch={watch}
    />
  )
}
