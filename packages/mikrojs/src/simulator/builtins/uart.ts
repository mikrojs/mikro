import type {BuiltinDefinition} from './types.js'

export const uartBuiltin: BuiltinDefinition = {
  source: `
import {ok} from 'mikrojs/result'

export class Uart {
  constructor(_port, _options) {}
  begin() { return ok() }
  end() { return ok() }
  write(_data) { return ok() }
  read() {
    // Return an async iterable that never yields (no real UART in sim)
    const iter = {
      next() { return new Promise(() => {}) },
      return() { return Promise.resolve({done: true, value: undefined}) },
      [Symbol.asyncIterator]() { return iter },
    }
    return ok(iter)
  }
}
`,
}
