/* Minimal AbortController / AbortSignal implementation.
 *
 * This is a lightweight subset of the WHATWG DOM spec: just enough
 * for fetch timeouts and cooperative cancellation. No EventTarget
 * dependency: listeners are stored in a simple array.
 *
 * Evaluating this module installs AbortController, AbortSignal,
 * AbortError, and TimeoutError on globalThis. It is loaded lazily by
 * the native lazy getters in mik_abort.cpp on first access to any of
 * the four globals; shipping it as precompiled bytecode keeps the
 * QuickJS parser out of the install path (parsing at runtime caused
 * OOM on low-memory chips).
 */

class AbortError extends Error {
  constructor(message?: string) {
    super(message || 'The operation was aborted')
  }
  get name() {
    return 'AbortError'
  }
}

class TimeoutError extends Error {
  constructor(message?: string) {
    super(message || 'The operation timed out')
  }
  get name() {
    return 'TimeoutError'
  }
}

const _a: unique symbol = Symbol()
const _r: unique symbol = Symbol()
const _l: unique symbol = Symbol()
const _s: unique symbol = Symbol()

function doAbort(signal: AbortSignal, reason: unknown): void {
  if (signal[_a]) return
  signal[_a] = true
  signal[_r] = reason
  if (typeof signal.onabort === 'function') signal.onabort()
  for (const fn of signal[_l]) fn()
}

class AbortSignal {
  [_a] = false;
  [_r]: unknown = undefined;
  [_l]: (() => void)[] = []
  onabort: (() => void) | null = null

  get aborted(): boolean {
    return this[_a]
  }
  get reason(): unknown {
    return this[_r]
  }
  throwIfAborted(): void {
    if (this[_a]) throw this[_r]
  }
  addEventListener(type: 'abort', fn: () => void): void {
    if (type === 'abort' && typeof fn === 'function') this[_l].push(fn)
  }
  removeEventListener(type: 'abort', fn: () => void): void {
    if (type === 'abort') this[_l] = this[_l].filter((f) => f !== fn)
  }
  static abort(reason?: unknown): AbortSignal {
    const s = new AbortSignal()
    doAbort(s, reason !== undefined ? reason : new AbortError())
    return s
  }
  static timeout(ms: number): AbortSignal {
    const s = new AbortSignal()
    setTimeout(() => doAbort(s, new TimeoutError()), ms)
    return s
  }
  static any(signals: AbortSignal[]): AbortSignal {
    const s = new AbortSignal()
    for (const i of signals) {
      if (i.aborted) {
        doAbort(s, i.reason)
        return s
      }
    }
    for (const i of signals) {
      i.addEventListener('abort', () => doAbort(s, i.reason))
    }
    return s
  }
}

class AbortController {
  [_s] = new AbortSignal()

  get signal(): AbortSignal {
    return this[_s]
  }
  abort(reason?: unknown): void {
    doAbort(this[_s], reason !== undefined ? reason : new AbortError())
  }
}

/* Object.defineProperties, NOT Object.assign: when this module is
 * evaluated via a direct `import 'mikro/abort'` (it is in the builtins
 * table), the four lazy getters installed by mik_abort.cpp are still
 * present as setter-less accessors, and Object.assign's [[Set]] would
 * throw "no setter for property". Defining replaces the accessors with
 * plain data properties, matching what the lazy-getter path produces. */
const descriptor = (value: unknown) => ({
  value,
  writable: true,
  enumerable: true,
  configurable: true,
})
Object.defineProperties(globalThis, {
  AbortError: descriptor(AbortError),
  TimeoutError: descriptor(TimeoutError),
  AbortSignal: descriptor(AbortSignal),
  AbortController: descriptor(AbortController),
})
