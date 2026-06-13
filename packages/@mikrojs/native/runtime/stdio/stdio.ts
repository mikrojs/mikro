import * as native from 'native:mikro/stdio'

import type {StdIn, StdOut} from './types.js'

function createStdIn(nativeStdin: typeof native.stdin): StdIn {
  const listeners: ((buffer: Uint8Array) => void)[] = []

  function onData(chunk: Uint8Array) {
    listeners.forEach((listener) => listener(chunk))
  }

  return {
    addListener(_event: 'data', callback: (buffer: Uint8Array) => void) {
      if (!listeners.includes(callback)) {
        listeners.push(callback)
        if (listeners.length === 1) {
          nativeStdin.setHandler(onData)
        }
      }
    },
    removeListener(_event: 'data', callback: (buffer: Uint8Array) => void) {
      const idx = listeners.indexOf(callback)
      if (idx > -1) {
        listeners.splice(idx, 1)
        if (listeners.length === 0) {
          nativeStdin.clearHandler()
        }
      }
    },
    read: nativeStdin.read,
  }
}

function createStdOut(nativeStdout: typeof native.stdout): StdOut {
  return {
    write: nativeStdout.write,
    flush: nativeStdout.flush,
    isTTY: false,
    getWindowSize: undefined,
  }
}

export const stdin = createStdIn(native.stdin)
export const stdout = createStdOut(native.stdout)
