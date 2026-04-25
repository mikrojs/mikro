export {err, ok} from 'native:result'

export class PanicError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'PanicError'
  }
}

export function defineError<D extends Record<string, (...args: any[]) => Record<string, unknown>>>(
  _name: string,
  variants: D,
): {[K in keyof D & string]: (...args: Parameters<D[K]>) => {name: K} & ReturnType<D[K]>} {
  const constructors: Record<string, (...args: unknown[]) => Record<string, unknown>> = {}
  for (const key in variants) {
    const factory = variants[key]!
    constructors[key] = (...args: unknown[]) => {
      const fields = (factory as (...a: unknown[]) => Record<string, unknown>)(...args)
      fields.name = key
      return fields
    }
  }
  return constructors as unknown as {
    [K in keyof D & string]: (...args: Parameters<D[K]>) => {name: K} & ReturnType<D[K]>
  }
}
