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
  return (handlers as unknown as Record<string, (e: E) => R>)[error.name]!(error)
}
