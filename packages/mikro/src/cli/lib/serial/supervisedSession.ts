/**
 * SupervisedSession — a `ReplSession` that survives transient serial
 * disconnects.
 *
 * The state machine in `replStateMachine` binds to a single `ReplSession`
 * for its lifetime: it subscribes once to `messages$` and calls
 * `awaitReady$` once. To stay alive across USB re-enumerations (e.g. light
 * sleep on USJ-console chips), this wrapper owns the inner `ReplSession`
 * lifecycle, swaps the inner instance on disconnect, and re-drives the
 * handshake on the new instance — all transparent to the state machine.
 *
 * Events surfaced to the state machine (in addition to the inner
 * session's events):
 *   - `{type: 'reconnecting'}` when the inner disconnects and we're
 *     starting the reconnect poll. The state machine renders a subtle
 *     "Reconnecting…" footer line.
 *   - `{type: 'reconnected'}` after the new transport is open. The new
 *     inner's MSG_READY (delivered via `messages$` shortly after) drives
 *     the state machine back to `ready`.
 *   - `{type: 'disconnect', error: '...'}` if the device doesn't return
 *     within the timeout — the same shape as a hard transport error, so
 *     the state machine's existing handler surfaces it as an error.
 */

import {
  BehaviorSubject,
  filter,
  merge,
  type Observable,
  share,
  Subject,
  type Subscription,
  switchMap,
} from 'rxjs'
import {SerialPort} from 'serialport'

import {
  connectRepl,
  type ConnectReplOptions,
  type ReadyEvent,
  type ReplEvent,
  type ReplSession,
} from '../session.js'
import {createSerialTransport} from '../transport.js'

/** How long to keep trying to reopen the port before giving up. Defaults
 *  to Infinity: once the initial connect has succeeded, the supervisor
 *  trusts that the device exists and will wait indefinitely for it to
 *  come back. This covers arbitrarily long deep sleeps and brief replugs
 *  without racing the user. Ctrl+C is always available if the device
 *  really is gone. */
const RECONNECT_TIMEOUT_MS = Infinity
/** Interval between `SerialPort.list()` scans while waiting for our device
 *  to reappear. We identify the device by its USB serial, not its path, so
 *  we must enumerate ports to find where it landed — it may re-enumerate
 *  onto a *different* path after sleep or a replug. */
const PORT_SCAN_INTERVAL_MS = 100

export interface SupervisedSessionOptions {
  devicePath: string
  baudRate: number
  /** USB serial of the device we connected to. Reconnect re-finds the
   *  device by this serial across port changes, so a board that comes back
   *  on a different path is followed and a *different* board that grabs the
   *  old path is ignored. Undefined for devices without a USB serial (some
   *  UART bridges); reconnect then falls back to watching the original path. */
  serialNumber?: string
  /** Total ms to wait for the device to reappear before giving up.
   *  Defaults to Infinity (see `RECONNECT_TIMEOUT_MS`). */
  reconnectTimeoutMs?: number
  /** Called when a reconnect cycle starts, before the `'reconnecting'`
   *  event reaches the state machine. Useful for aborting in-flight
   *  deploys. */
  onReconnectStart?: () => void
  /** Firmware-version policy forwarded to every inner `connectRepl`
   *  (initial connect and reconnects). See {@link ConnectReplOptions.compat}. */
  compat?: ConnectReplOptions['compat']
}

interface Inner {
  serial: SerialPort
  session: ReplSession
}

function buildInner(serial: SerialPort, compat: ConnectReplOptions['compat']): Inner {
  return {serial, session: connectRepl(createSerialTransport(serial), {compat})}
}

function closeInner(inner: Inner): void {
  try {
    inner.session.close()
  } catch {
    // already closed
  }
  try {
    if (inner.serial.isOpen) inner.serial.close()
  } catch {
    // already closed
  }
}

function openSerialOnce(path: string, baudRate: number): Promise<SerialPort> {
  return new Promise((resolve, reject) => {
    const sp = new SerialPort({path, baudRate, autoOpen: false})
    sp.open((err) => (err ? reject(err) : resolve(sp)))
  })
}

/**
 * Resolve the path our device currently lives on. With a known USB serial
 * we follow the device wherever it re-enumerated (a different path is fine,
 * and a stranger on the old path is ignored). Without a serial we can only
 * watch the original path. Returns undefined while the device is absent.
 */
async function findDevicePath(
  serialNumber: string | undefined,
  fallbackPath: string,
): Promise<string | undefined> {
  const ports = await SerialPort.list()
  if (serialNumber != null) {
    return ports.find((p) => p.serialNumber === serialNumber)?.path
  }
  return ports.find((p) => p.path === fallbackPath)?.path
}

/**
 * Poll `SerialPort.list()` at `PORT_SCAN_INTERVAL_MS` until our device
 * appears on some port and opens, or `timeoutMs` elapses. Identity is the
 * USB serial, so we adopt the device on whatever path it lands on and never
 * adopt a different device that took the old path.
 */
async function waitForDevice(
  opts: SupervisedSessionOptions,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SerialPort> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('reconnect aborted')
    const path = await findDevicePath(opts.serialNumber, opts.devicePath)
    if (path) {
      try {
        return await openSerialOnce(path, opts.baudRate)
      } catch (err) {
        // Port is listed but not yet openable (still settling). Retry.
        lastErr = err
      }
    }
    await new Promise((r) => setTimeout(r, PORT_SCAN_INTERVAL_MS))
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Device did not return within ${Math.round(timeoutMs / 1000)}s`)
}

/**
 * Wrap an already-open SerialPort into a self-supervising ReplSession.
 * The caller hands off ownership of `initialSerial`; closing the returned
 * session closes the underlying port.
 */
export function createSupervisedSession(
  initialSerial: SerialPort,
  opts: SupervisedSessionOptions,
): ReplSession {
  const reconnectTimeoutMs = opts.reconnectTimeoutMs ?? RECONNECT_TIMEOUT_MS

  let closed = false
  let reconnectAbort: AbortController | null = null
  let innerDisconnectSub: Subscription | null = null

  const inner$ = new BehaviorSubject<Inner>(buildInner(initialSerial, opts.compat))
  // Synthetic supervisor-level events injected into the outer stream
  // (`reconnecting`, `reconnected`, and the final terminal disconnect on
  // reconnect timeout).
  const supervisorEvents$ = new Subject<ReplEvent>()

  // Watch the current inner's stream for its terminal `disconnect`. When
  // it fires, suppress it from the outer stream (the outer subscriber
  // sees `'reconnecting'` instead) and start the reconnect loop.
  function watchInnerForDisconnect(inner: Inner): void {
    innerDisconnectSub?.unsubscribe()
    innerDisconnectSub = inner.session.messages$
      .pipe(filter((e): e is Extract<ReplEvent, {type: 'disconnect'}> => e.type === 'disconnect'))
      .subscribe((event) => {
        if (closed) {
          supervisorEvents$.next(event)
          supervisorEvents$.complete()
          return
        }
        if (event.error) {
          // Hard transport error (e.g. write failure). Don't auto-reconnect;
          // surface the original error so the state machine shows it.
          supervisorEvents$.next(event)
          supervisorEvents$.complete()
          return
        }
        opts.onReconnectStart?.()
        supervisorEvents$.next({type: 'reconnecting'})
        startReconnect(inner).catch(() => {
          // startReconnect handles its own errors via supervisorEvents$.
        })
      })
  }
  watchInnerForDisconnect(inner$.value)

  async function startReconnect(previous: Inner): Promise<void> {
    reconnectAbort?.abort()
    const ac = new AbortController()
    reconnectAbort = ac

    // Release the OS handle on the old port so the re-enumerated device
    // can grab the same path.
    closeInner(previous)

    try {
      // Re-find the device by its USB serial (not its old path) and open it.
      // A different board that took the old path won't match and is ignored;
      // our board is followed onto whatever path it re-enumerated to.
      const serial = await waitForDevice(opts, reconnectTimeoutMs, ac.signal)

      const next = buildInner(serial, opts.compat)
      watchInnerForDisconnect(next)
      inner$.next(next)
      supervisorEvents$.next({type: 'reconnected'})
      // Drive HELLO on the new inner so MSG_READY flows through and the
      // state machine transitions back to `ready`. Errors are swallowed:
      // a firmware-incompat or timeout will surface via `disconnect` on
      // its own when the inner closes.
      next.session.awaitReady$().subscribe({error: () => {}})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      supervisorEvents$.next({type: 'disconnect', error: message})
      supervisorEvents$.complete()
    }
  }

  // Outer messages$: current inner's events (minus its terminal
  // `disconnect`) + supervisor-injected events.
  const innerEvents$: Observable<ReplEvent> = inner$.pipe(
    switchMap((inner) => inner.session.messages$.pipe(filter((e) => e.type !== 'disconnect'))),
  )
  const messages$: Observable<ReplEvent> = merge(innerEvents$, supervisorEvents$).pipe(share())
  // Keep the pipeline warm so inner subscriptions stay live even when
  // the state machine momentarily has no active subscription.
  const keepalive = messages$.subscribe()

  function current(): ReplSession {
    return inner$.value.session
  }

  return {
    messages$,
    ready$: messages$.pipe(filter((e): e is ReadyEvent => e.type === 'ready')),
    eval(code) {
      current().eval(code)
    },
    directive(name) {
      current().directive(name)
    },
    complete(partial) {
      current().complete(partial)
    },
    exit() {
      current().exit()
    },
    awaitReady$(timeoutMs) {
      return current().awaitReady$(timeoutMs)
    },
    deploy(deployOpts) {
      return current().deploy(deployOpts)
    },
    eraseApp(eraseOpts) {
      return current().eraseApp(eraseOpts)
    },
    fsGet(path) {
      return current().fsGet(path)
    },
    logsReset() {
      return current().logsReset()
    },
    restart() {
      current().restart()
    },
    config: {
      list: () => current().config.list(),
      set: (k, v, s) => current().config.set(k, v, s),
      delete: (k) => current().config.delete(k),
    },
    close() {
      if (closed) return
      closed = true
      reconnectAbort?.abort()
      innerDisconnectSub?.unsubscribe()
      keepalive.unsubscribe()
      closeInner(inner$.value)
      supervisorEvents$.complete()
    },
  }
}
