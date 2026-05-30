// Global APIs available in the QuickJS runtime environment

declare function setTimeout(callback: (...args: any[]) => void, ms?: number): number
declare function clearTimeout(id: number): void

declare function setInterval(callback: (...args: any[]) => void, ms?: number): number
declare function clearInterval(id: number): void

declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

declare function btoa(data: string): string
declare function atob(data: string): string

declare class TextEncoder {
  encode(input?: string): Uint8Array
}

declare class TextDecoder {
  constructor(label?: 'utf-8' | 'utf8')
  decode(input?: Uint8Array, options?: {stream?: boolean}): string
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

declare interface JSON {
  parse(text: string, reviver?: (this: any, key: string, value: any) => any): unknown
}

declare interface ImportMeta {
  readonly url: string
  readonly main: boolean
  readonly dirname: string
  readonly basename: string
  readonly path: string
  readonly env: Readonly<Record<string, string | undefined>>
}
