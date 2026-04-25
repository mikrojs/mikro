export declare class PanicError extends Error {
  constructor(message: string, options?: {cause?: unknown})
}

export interface OkResult<T> {
  readonly ok: true
  readonly value: T
  readonly error?: never
  map<U>(fn: (value: T) => U): OkResult<U>
  mapErr<F>(fn: (error: never) => F): OkResult<T>
  andThen<U, F>(fn: (value: T) => Result<U, F>): Result<U, F>
  match<A, B>(handlers: {ok: (value: T) => A; err: (error: never) => B}): A
  /** Get the value, or return the default if this is an Err. */
  orDefault<D>(defaultValue: D): T | D
  /** Get the value, or panic with the given message if this is an Err. */
  orPanic(message: string): T
}

export interface ErrResult<E> {
  readonly ok: false
  readonly value?: never
  readonly error: E
  map<U>(fn: (value: never) => U): ErrResult<E>
  mapErr<F>(fn: (error: E) => F): ErrResult<F>
  andThen<U, F>(fn: (value: never) => Result<U, F>): ErrResult<E>
  match<A, B>(handlers: {ok: (value: never) => A; err: (error: E) => B}): B
  /** Return the default value since this is an Err. */
  orDefault<D>(defaultValue: D): D
  /** Always panics with the given message since this is an Err. The error is included as cause. */
  orPanic(message: string): never
}

export type Result<T, E> = OkResult<T> | ErrResult<E>

export declare function ok(): OkResult<void>
export declare function ok<T>(value: T): OkResult<T>

export declare function err<E>(error: E): ErrResult<E>

type VariantDef = Record<string, (...args: any[]) => Record<string, unknown>>

type ErrorConstructors<D extends VariantDef> = {
  [K in keyof D & string]: (...args: Parameters<D[K]>) => {name: K} & ReturnType<D[K]>
}

export type ErrorOf<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T & string]: ReturnType<T[K]>
}[keyof T & string]

export declare function defineError<D extends VariantDef>(
  name: string,
  variants: D,
): ErrorConstructors<D>

/** Raw error shape returned by native mik__result_err(). */
export interface NativeError {
  readonly code: number
  readonly message: string
  readonly errno?: number
}
