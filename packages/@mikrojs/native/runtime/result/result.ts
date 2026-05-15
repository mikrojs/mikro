export {err, ok} from 'native:result'

export class PanicError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'PanicError'
  }
}

export function matchError<E extends {name: string}, R>(
  error: E,
  handlers: {[K in E['name']]: (error: Extract<E, {name: K}>) => R},
): R {
  // hasOwn guard: bare `handlers[error.name]` would resolve to Object.prototype
  // methods (toString, hasOwnProperty, …) for any error.name string that
  // happens to match a prototype member — silently returning a wrong value
  // instead of failing loudly. The type system enforces `name` is one of the
  // union's tags, but interop with native or hand-built error objects can
  // bypass that.
  const h = handlers as unknown as Record<string, (e: E) => R>
  if (!Object.hasOwn(h, error.name)) {
    throw new TypeError(`matchError: no handler for ${error.name}`)
  }
  return h[error.name]!(error)
}
