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

declare interface ImportMeta {
  readonly url: string
  readonly main: boolean
  readonly dirname: string
  readonly basename: string
  readonly path: string
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Evict a module from the runtime's module cache, recursively freeing
   * any transitive dependency whose only importer was the unloaded module.
   * Builtin modules (native:*, mikrojs/*, @mikrojs/*) are anchored
   * and cannot be unloaded.
   *
   * Intended for use with dynamic imports: a static `import` at the top of
   * the module creates a binding that pins the imported module's exports,
   * so unloading it while the binding is live reclaims nothing. Prefer
   * `const x = await import(spec)` + local scope + `import.meta.unload(spec)`.
   *
   * **Incompatible with `bundle: true`.** When the build bundles modules
   * into chunks, source-level specifiers like `./phases/display.js` no
   * longer correspond to loaded module names (they become chunk names like
   * `display-GYVGL5MB.js`) — the unload call silently resolves to 0 and
   * frees nothing. Projects that rely on dynamic-import-then-unload for
   * memory reclaim need `bundle: false` so specifier strings survive to
   * runtime unchanged.
   *
   * Resolves to the number of modules actually freed (root + transitive
   * orphans), after a GC pass has run so a subsequent `memoryUsage()`
   * snapshot reflects the reclaim.
   */
  unload(specifier: string): Promise<number>
}
