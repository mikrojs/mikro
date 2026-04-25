import type {BuiltinDefinition} from './types.js'

export const uartBuiltin: BuiltinDefinition = {
  source: `
export class Uart {
  constructor(_port, _options) {}
  begin() { return {ok: true} }
  end() { return {ok: true} }
  write(_data) { return {ok: true} }
  read() {
    // Return an async iterable that never yields (no real UART in sim)
    const iter = {
      next() { return new Promise(() => {}) },
      return() { return Promise.resolve({done: true, value: undefined}) },
      [Symbol.asyncIterator]() { return iter },
    }
    return {ok: true, value: iter}
  }
}
`,
}
