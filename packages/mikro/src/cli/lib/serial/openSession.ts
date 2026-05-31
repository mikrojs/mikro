import {SerialPort} from 'serialport'

import {BAUD_RATE, resolvePort} from '../deploy.js'
import {triggerSafeMode} from '../recover.js'
import {connectRepl, type ReplSession} from '../session.js'
import {createSerialTransport} from '../transport.js'

export interface SessionHandles {
  session: ReplSession
  serial: SerialPort
  devicePath: string
  /** Close session + serial. Safe to call more than once. */
  close(): void
}

export interface OpenSessionOptions {
  port?: string
  /**
   * Safe-mode recovery. Runs `triggerSafeMode` after the session has
   * subscribed — the post-reset MSG_READY needs that eager subscription
   * to be in place.
   */
  recover?: boolean
  /** Called with the resolved device path before the serial is opened. */
  onConnecting?: (path: string) => void
  /**
   * Firmware-version policy. 'best-effort' lets read-only diagnostic
   * commands proceed against incompatible firmware with a warning instead
   * of a hard error. Defaults to 'enforce'. See ConnectReplOptions.compat.
   */
  compat?: 'enforce' | 'best-effort'
}

/**
 * Resolve a port, open the serial, and bring up a `ReplSession`. The returned
 * handles close the session and the serial when `close()` is called. The
 * session is created before any optional `triggerSafeMode` call so the
 * eager subscription is listening when the post-reset MSG_READY arrives.
 */
export async function openSession(options: OpenSessionOptions): Promise<SessionHandles> {
  const devicePath = await resolvePort(options.port)
  options.onConnecting?.(devicePath)

  const serial = new SerialPort({path: devicePath, baudRate: BAUD_RATE, autoOpen: false})
  await new Promise<void>((resolve, reject) => {
    serial.open((err) => (err ? reject(err) : resolve()))
  })

  const transport = createSerialTransport(serial)
  const session = connectRepl(transport, {compat: options.compat})

  if (options.recover === true) {
    await triggerSafeMode(serial)
  }

  let closed = false
  return {
    session,
    serial,
    devicePath,
    close() {
      if (closed) return
      closed = true
      try {
        session.close()
      } catch {
        // already closed
      }
      try {
        serial.close()
      } catch {
        // already closed
      }
    },
  }
}
