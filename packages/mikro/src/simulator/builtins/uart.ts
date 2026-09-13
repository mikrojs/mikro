import type {BuiltinDefinition} from './types.js'

export const uartBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for uart
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {err, ok} from 'mikro/result'
import type {SimUart} from 'mikro/sim'

type Chunk = IteratorResult<unknown>

// The factory is overloaded on its options, so the implementation is cast to its type.
export const Uart = ((port: number, options: {tx?: number; rx?: number; baudRate: number}) => {
  let released = false
  let warned = false
  let reading = false
  // Completes the active reader, if any.
  let stopReader: (() => void) | undefined
  // Reports use of a handle after end() once, as the device does.
  function ended(call: string) {
    if (!released) return false
    if (!warned) {
      warned = true
      console.error('Uart ' + port + ': ' + call + ' after end(); the handle no longer owns the port')
    }
    return true
  }
  const done: Chunk = {done: true, value: undefined}
  return ok({
    write(_data: Uint8Array) {
      if (ended('write()')) return ok()
      if (options.tx === undefined) return err({name: 'NoTxPin' as const})
      return ok()
    },
    read() {
      const finished = ended('read()')
      if (!finished && options.rx === undefined) return err({name: 'NoRxPin' as const})
      if (!finished && reading) return err({name: 'AlreadyReading' as const})
      let stopped = finished
      let finishPending: ((chunk: Chunk) => void) | undefined
      function stop() {
        stopped = true
        reading = false
        finishPending?.(done)
        finishPending = undefined
      }
      if (!finished) {
        reading = true
        stopReader = stop
      }
      const iter = {
        // Nothing sends on a simulated port, so next() waits until end() or return().
        next(): Promise<Chunk> {
          if (stopped) return Promise.resolve(done)
          return new Promise((resolve) => {
            finishPending = resolve
          })
        },
        return(): Promise<Chunk> {
          if (stopReader === stop) stop()
          stopped = true
          return Promise.resolve(done)
        },
        [Symbol.asyncIterator]() {
          return iter
        },
      }
      return ok(iter)
    },
    end() {
      if (released) return
      released = true
      stopReader?.()
    },
  })
}) as unknown as SimUart['Uart']
`,
}
