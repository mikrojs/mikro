// Host-side shim for `native:mikro/result` used only in vitest (Node) where the
// mikrojs C runtime isn't available. Keep in sync with mik_result.cpp.

const proto = {
  map(this: {ok: boolean; value?: unknown; error?: unknown}, fn: (v: unknown) => unknown) {
    return this.ok ? ok(fn(this.value)) : this
  },
  mapErr(this: {ok: boolean; value?: unknown; error?: unknown}, fn: (e: unknown) => unknown) {
    return this.ok ? this : err(fn(this.error))
  },
  andThen(this: {ok: boolean; value?: unknown; error?: unknown}, fn: (v: unknown) => unknown) {
    return this.ok ? fn(this.value) : this
  },
  match(
    this: {ok: boolean; value?: unknown; error?: unknown},
    handlers: {ok: (v: unknown) => unknown; err: (e: unknown) => unknown},
  ) {
    return this.ok ? handlers.ok(this.value) : handlers.err(this.error)
  },
  orDefault(this: {ok: boolean; value?: unknown; error?: unknown}, defaultValue: unknown) {
    return this.ok ? this.value : defaultValue
  },
  orPanic(this: {ok: boolean; value?: unknown; error?: unknown}, message?: string) {
    if (this.ok) return this.value
    const panic = new Error(message)
    panic.name = 'PanicError'
    ;(panic as Error & {cause?: unknown}).cause = this.error
    throw panic
  },
}

export function ok(value?: unknown): unknown {
  const r = Object.create(proto)
  r.ok = true
  if (arguments.length > 0) r.value = value
  return r
}

// atob/btoa are untyped in this tsconfig
const g = globalThis as unknown as Record<string, unknown>
const safeBuiltins: unknown[] = [
  JSON.parse,
  JSON.stringify,
  g.atob,
  g.btoa,
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
  RegExp,
  String.fromCodePoint,
]

export function safe(fn: (...args: unknown[]) => unknown, ...args: unknown[]): unknown {
  if (!safeBuiltins.includes(fn)) {
    throw new TypeError(
      'safe: expected one of JSON.parse, JSON.stringify, atob, btoa, decodeURI, ' +
        'decodeURIComponent, encodeURI, encodeURIComponent, RegExp, String.fromCodePoint',
    )
  }
  const name =
    fn === JSON.parse
      ? 'JSON.parse reviver'
      : fn === JSON.stringify
        ? 'JSON.stringify replacer'
        : ''
  const callArgs = name
    ? args.slice(0, 3).map((a, i) =>
        i === 1 && typeof a === 'function'
          ? function (this: unknown, ...cbArgs: unknown[]) {
              try {
                return a.apply(this, cbArgs)
              } catch (cause) {
                throw new Error(`${name} threw`, {cause})
              }
            }
          : a,
      )
    : args
  try {
    return ok(fn(...callArgs))
  } catch (e) {
    return err(e)
  }
}

export function tryCall(fn: (() => unknown) | Promise<unknown>): unknown {
  if (fn instanceof Promise) return fn.then(ok, err)
  if (typeof fn !== 'function') throw new TypeError('tryCall: expected a function or a promise')
  let value: unknown
  try {
    value = fn()
  } catch (e) {
    return err(e)
  }
  return value instanceof Promise ? value.then(ok, err) : ok(value)
}

export function err(error: unknown): unknown {
  const r = Object.create(proto)
  r.ok = false
  r.error = error
  return r
}
