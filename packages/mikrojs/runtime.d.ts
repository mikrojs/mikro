declare type FormatString = string & {}

declare module '*.txt' {
  declare const mod: string
  export default mod
}

/* @mikrojs/native runtime files (e.g. observable/operators.ts) get pulled
 * into mikrojs's typecheck via `_exports/observable/operators.ts` and need
 * the `native:observable` ambient resolvable from this package too. The
 * authoritative declaration lives in @mikrojs/native/runtime/internal.d.ts;
 * this mirror keeps mikrojs's tsc from going to `any`. */
declare module 'native:observable' {
  export {Observable} from '@mikrojs/native/runtime/observable/types'
}

declare interface LogFn {
  (fmt: FormatString, ...args: any[]): void

  (...args: any[]): void
}

declare function setInterval(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  handler: string | Function,
  timeout?: number,
  ...arguments: any[]
): number
declare function setTimeout(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  handler: string | Function,
  timeout?: number,
  ...arguments: any[]
): number
declare function clearInterval(id: number | undefined): void
declare function clearTimeout(id: number | undefined): void

declare function btoa(data: string): string
declare function atob(data: string): string

declare let global: typeof globalThis
declare let console: {
  debug: LogFn
  log: LogFn
  info: LogFn
  error: LogFn
  warn: LogFn
}

declare class AbortError extends Error {
  constructor(message?: string)
  readonly name: 'AbortError'
}

declare class TimeoutError extends Error {
  constructor(message?: string)
  readonly name: 'TimeoutError'
}

declare class AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  throwIfAborted(): void
  onabort: (() => void) | null
  addEventListener(type: 'abort', fn: () => void): void
  removeEventListener(type: 'abort', fn: () => void): void
  static abort(reason?: unknown): AbortSignal
  static timeout(ms: number): AbortSignal
  static any(signals: AbortSignal[]): AbortSignal
}

declare class AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

declare interface ImportMetaEnv {
  [key: string]: string | undefined
}

declare interface ImportMeta {
  readonly env: Readonly<ImportMetaEnv>
}

declare class TextEncoder {
  encode(input?: string): Uint8Array
}

declare class TextDecoder {
  constructor(label?: 'utf-8' | 'utf8')
  decode(input?: ArrayBufferView | ArrayBuffer, options?: {stream?: boolean}): string
}
