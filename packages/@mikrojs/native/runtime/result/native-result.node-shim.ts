// Host-side shim for `native:result` used only in vitest (Node) where the
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
  orPanic(this: {ok: boolean; value?: unknown; error?: unknown}, message: string) {
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

export function err(error: unknown): unknown {
  const r = Object.create(proto)
  r.ok = false
  r.error = error
  return r
}
