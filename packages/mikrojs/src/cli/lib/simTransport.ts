/**
 * IPC transport for the simulator subprocess.
 *
 * Spawns simProcess.js as a child process and wraps its stdin/stdout
 * as a Transport, identical to createSerialTransport but over stdio pipes.
 */

import {type ChildProcess, spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'

import {Observable} from 'rxjs'

import type {Transport} from './transport.js'

export interface SimTransportOptions {
  fsRoot: string
  memLimit?: number
  fsLimit?: number
  fsReadMax?: number
  /** Path to project directory for sim/ stubs */
  simDir?: string
}

export function createSimTransport(options: SimTransportOptions): Transport {
  const entryPath = fileURLToPath(new URL('../../simulator/simProcess.js', import.meta.url))
  const args = ['--fs-root', options.fsRoot]
  if (options.memLimit) args.push('--mem-limit', String(options.memLimit))
  if (options.fsLimit) args.push('--fs-limit', String(options.fsLimit))
  if (options.fsReadMax) args.push('--fs-read-max', String(options.fsReadMax))
  if (options.simDir) args.push('--sim-dir', options.simDir)

  // Inherit stderr so fatal errors and warnings from simProcess surface in the
  // user's terminal. Previously this was 'ignore', which meant a crashing
  // subprocess would manifest only as a cryptic EPIPE on the parent when the
  // next TLV frame was written. simProcess only writes to stderr on real
  // problems, so inheriting it doesn't pollute normal runs.
  const child: ChildProcess = spawn(process.execPath, [entryPath, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  // Track child exit so we can synthesize a clear error for writes that
  // race with a dead subprocess (otherwise EPIPE becomes an unhandled 'error'
  // event and crashes the parent).
  let exitInfo: {code: number | null; signal: NodeJS.Signals | null} | null = null
  child.on('exit', (code, signal) => {
    exitInfo = {code, signal}
  })
  // Install an error listener on stdin so EPIPE from writes doesn't crash the
  // parent. We surface it via the data observable instead.
  child.stdin?.on('error', () => {
    /* swallowed here; write() below re-reports as a transport error */
  })

  const data = new Observable<Uint8Array>((subscriber) => {
    const onData = (chunk: Buffer) => subscriber.next(new Uint8Array(chunk))
    const onEnd = () => subscriber.complete()
    const onError = (err: Error) => subscriber.error(err)
    const onExit = () => {
      if (exitInfo && exitInfo.code !== 0) {
        subscriber.error(
          new Error(
            `simProcess exited unexpectedly (code=${exitInfo.code} signal=${exitInfo.signal ?? 'none'})`,
          ),
        )
      } else {
        subscriber.complete()
      }
    }

    child.stdout!.on('data', onData)
    child.stdout!.on('end', onEnd)
    child.stdout!.on('error', onError)
    child.on('exit', onExit)

    return () => {
      child.stdout!.off('data', onData)
      child.stdout!.off('end', onEnd)
      child.stdout!.off('error', onError)
      child.off('exit', onExit)
    }
  })

  return {
    write(chunk: Uint8Array): Promise<void> {
      if (exitInfo !== null) {
        return Promise.reject(
          new Error(
            `cannot write to simProcess: subprocess has exited (code=${exitInfo.code} signal=${exitInfo.signal ?? 'none'})`,
          ),
        )
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin!.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()))
      })
    },
    data,
    close(): void {
      child.stdin!.end()
      child.kill()
    },
  }
}
